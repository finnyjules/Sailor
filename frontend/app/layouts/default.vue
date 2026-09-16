<script setup lang="ts">
import {
  House, X, Plus, Play, Check, Minus, ExternalLink, AlertCircle,
  MousePointer2, Hand, LayoutGrid, GitFork, Image, Workflow, AppWindow, LayoutTemplate, Sparkles, Toolbox, WandSparkles, Boxes,
  ZoomIn, ZoomOut, Maximize2, Map, Globe, Square, PanelRight, Wand, Library,
  AudioWaveform, Film, Box, Type, Frame,
  StickyNote, ListChecks, ArrowRight, MessageSquareDashed, Drama, Ellipsis, Table2,
  Shapes, ListVideo,
  Sparkle, ImagePlus, Brush, Music, Mic, ChevronDown, Palette, Images,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { useDeliverables } from '~/composables/useDeliverables'
import { peekPendingPromote } from '~/lib/draft/runMeta'
import { tweenValue, shouldAnimateWalletChange } from '~/lib/countTween'
import RollingNumber from '~/components/RollingNumber.vue'
import { injectLoraStyleIntoPrompt } from '~/lib/graph/styleInject'
import { applyPendingPromotes } from '~/lib/draft/promote'
import { healDanglingLinks, stripVarsLinks, collectKeepSet, collectKeepSetDownstream } from '~/composables/useFilteredPrompt'
import { stripFrontendOnlyNodes } from '~/utils/stripFrontendOnlyNodes'
import { FRONTEND_ONLY_NODE_TYPES } from '~/lib/agent/capabilities'
import { brandKitToKv, brandSwatches as kitSwatches } from '~~/shared/brand/resolve'
import { SPACE_TYPE_ENABLED } from '~/lib/spaceTypeEnabled'
import type { ActionDomain } from '~/data/action-catalog'
import { STUDIO_OPTIONS } from '~/data/studio-options'
import { Sonner } from '~/components/ui/sonner'
import AssetsHistory from '~/components/AssetsHistory.vue'
import CommunityHome from '~/components/community/CommunityHome.vue'
import LoraTrainerSurface from '~/components/LoraTrainerSurface.vue'
import AllProjectsView from '~/components/AllProjectsView.vue'
import StartProjectModal from '~/components/StartProjectModal.vue'
import CanvasStatusBar, { type RunResult } from '~/components/CanvasStatusBar.vue'
import AgentCanvasPromptBar from '~/components/agent/CanvasPromptBar.vue'
import { ARTIFACT_NODE_FOR_SOURCE, type ActionSource } from '~/data/action-catalog'
import { estimateUsdForNodes, vueNodesToEstimateInput, type CostEstimate } from '~/lib/costEstimate'
import { formatCostBadge, formatEstimateBadge, formatEstimateLong } from '~/lib/pricing'
import { hostedModeEnabled, engineOrigin } from '~/lib/hostedMode'
import { tallyReplicateUsd } from '~/lib/graph/runCost'
import { summarizeNodeErrors } from '~/lib/validationErrors'
import { describeQueueRefusal, isH3RefusalBody } from '~/lib/queueRefusal'
import { isBetaGateError } from '~/lib/betaGate'
import { promoteTempImageInputs } from '~/lib/promoteTempImages'
import { extractOutputFiles, type GenOutput, type GenerationRecord } from '~/lib/generations'
import { extractCoverImages } from '~/lib/projectCover'
import { filterToExistingImages } from '~/lib/coverBackfill'
import {
  BLANK_WORKFLOW, activeCanvasOf, docHasContent, isProjectDoc,
  makeBlankWorkflow, makeCanvasId, nextCanvasName, pickNewerDoc, stampDocForSave, toProjectDoc,
  type ProjectCanvas, type ProjectDoc,
} from '~/lib/projectDoc'
import { setRef, type RefRegistry } from '~/lib/refs/registry'
import { graphToPrompt } from '~/lib/graph/graphToPrompt'
import { UnknownNodeTypeError } from '~/lib/graph/widgetOrder'
import { registerRun, markRunning, finishRun, inFlight, perRun, dropRunState, getRun, inFlightCount } from '~/lib/graph/runRegistry'
import { CostConfirmQueue } from '~/lib/graph/costConfirmQueue'
import { resolveCreditDelta, type CreditWatchCandidate } from '~/lib/graph/creditAttribution'
import { resolveEventTab } from '~/lib/graph/resolveEventTab'
import { withKeyedLock } from '~/lib/graph/keyedLock'
import { useDirectExecution } from '~/composables/useDirectExecution'
import { useDirectExecutionEnabled } from '~/composables/useDirectExecutionEnabled'
import { useShadowParity } from '~/composables/useShadowParity'
import { useVueNodes } from '~/composables/useVueNodes'

const { tabs, activeTabId, activeTab, setActiveTab, closeTab, openTab, updateTabStatus, renameTab, runningCount } = useTabs()
const { vueNodesEnabled } = useVueNodesEnabled()
const { directExecutionEnabled } = useDirectExecutionEnabled()
const direct = useDirectExecution()
const { objectInfo } = useVueNodes()
const route = useRoute()
const router = useRouter()

// ── Hosted mode ─────────────────────────────────────────────────────────
// Declared HERE, at the very top of setup, because it now gates seams that
// execute far earlier in this file than the wallet pill it was introduced for
// (the health probe's origin at first use, the run flow's bridge section, the
// engine iframes in the template). A const declared mid-file would be in its
// temporal dead zone for those.
const hostedShell = hostedModeEnabled(useRuntimeConfig().public)

// Deep-link: /?train=1 opens (or focuses) the Train tab — used by /dev/style-publisher.
onMounted(() => {
  if (route.query.train == null) return
  openTab({ type: 'train' })
  const { train: _train, ...rest } = route.query
  router.replace({ query: rest })
})

// Inline tab rename
const editingTabId = ref<string | null>(null)
const editingLabel = ref('')

function startRenaming(tabId: string, currentLabel: string) {
  editingTabId.value = tabId
  editingLabel.value = currentLabel
  nextTick(() => {
    const input = document.querySelector('[data-tab-rename-input]') as HTMLInputElement
    input?.focus()
    input?.select()
  })
}

function finishRenaming() {
  if (editingTabId.value && editingLabel.value.trim()) {
    renameTab(editingTabId.value, editingLabel.value)
    // Also persist the name for the home page recent projects
    const tab = tabs.value.find((t) => t.id === editingTabId.value)
    if (tab?.workflowId) {
      const { setProjectName } = useRecentProjects()
      setProjectName(tab.workflowId, editingLabel.value)
    }
  }
  editingTabId.value = null
}

function cancelRenaming() {
  editingTabId.value = null
}
const { explainActive, activateExplain, deactivateExplain, highlightedNodeId } = useExplain()
const { openNodeSearch } = useNodeSearch()

// Send highlight/clear to iframe when hovered node changes
watch(highlightedNodeId, (nodeId, oldNodeId) => {
  if (nodeId != null) {
    sendToActiveProjectIframe('highlightNode', { nodeId })
  }
  else if (oldNodeId != null) {
    sendToActiveProjectIframe('clearHighlight')
  }
})

// Ordered roughly along a typical session:
//   tools → sources → make/edit → power-user → help.
// `dividerBefore` draws a vertical separator before the item, marking
// the boundary between groups.
const sidebarItems = [
  // Tools
  { label: 'Select', icon: MousePointer2, tool: 'select' },
  { label: 'Hand', icon: Hand, tool: 'hand' },
  // Sources
  { label: 'Add', icon: Plus, submenu: 'load', dividerBefore: true },
  { label: 'Studios', icon: Shapes, submenu: 'studios' },
  { label: 'Generate', icon: Sparkle, submenu: 'generate', pastel: true },
  { label: 'Assets', icon: LayoutGrid, panel: 'assets' },
  // Make + edit
  { label: 'Actions', icon: WandSparkles, panel: 'generators', dividerBefore: true },
  { label: 'Styles', icon: Library, panel: 'loras' },
  { label: 'Characters', icon: Drama, panel: 'characters' },
  { label: 'Toolbox', icon: Toolbox, panel: 'toolbox' },
  // Power-user + annotate, folded into one overflow menu
  { label: 'More', icon: Ellipsis, submenu: 'more', dividerBefore: true },
  // Hidden for now. Re-add to restore.
  // { label: 'Apps', icon: AppWindow, tabId: 'apps' },
  { label: 'Templates', icon: LayoutTemplate, panel: 'templates' },
  // Help
  { label: 'Explain', icon: Sparkles, tool: 'explain', dividerBefore: true },
]

// Add menu — starting points only (spec §1: inert scaffolding). Two groups:
// Surfaces = places where work composes; Sources = media/data you bring in.
// Studios and Generate verbs live behind their own toolbar doors. 3D stays a
// disabled placeholder until the Mesh artifact node ships.
const loadSections = [
  { label: 'Surfaces', items: [
    { label: 'Frame', icon: Frame, nodeType: 'Compositor' },
    { label: 'Smart Layout', icon: LayoutTemplate, nodeType: 'SmartLayout' },
    { label: 'Timeline', icon: ListVideo, nodeType: 'Timeline' },
  ] },
  { label: 'Sources', items: [
    { label: 'Image', icon: Image, nodeType: 'Image' },
    { label: 'Text', icon: Type, nodeType: 'Text' },
    { label: 'Audio', icon: AudioWaveform, nodeType: 'Audio' },
    { label: 'Video', icon: Film, nodeType: 'Video' },
    { label: 'Collection', icon: Table2, nodeType: 'Collection' },
    { label: 'Moodboard', icon: Images, nodeType: 'Moodboard' },
    { label: '3D', icon: Box, nodeType: 'Mesh', disabled: true, hint: 'coming soon' },
  ] },
]

// One submenu open at a time. 'load' = Add, plus the Studios / Generate doors
// and the More overflow. null = all closed.
type SubmenuName = 'load' | 'studios' | 'generate' | 'more'
const openSubmenu = ref<SubmenuName | null>(null)

function addLoadNode(nodeType: string) {
  window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType } }))
  openSubmenu.value = null
}

// Load submenu click: most items drop their artifact node.
function onLoadOption(opt: { nodeType?: string; special?: string }) {
  openSubmenu.value = null
  // Space Type is a persistent, re-editable canvas node now — drop the node and
  // let VueNodeCanvas auto-open its editor (config persists in node properties).
  if (opt.special === 'space-type') { window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType: 'SpaceType' } })); return }
  if (opt.nodeType) addLoadNode(opt.nodeType)
}

// Studios door options — shared with the start modal (app/data/studio-options.ts).
const studiosOptions = STUDIO_OPTIONS

// Generate door — the curated zero-input AI verbs (spec §2). The fast lane,
// not the store: the full catalog lives in the Actions panel. Audio expands
// inline to its two nodes rather than widening the door to five items.
const generateOptions = [
  { label: 'Image', icon: ImagePlus, nodeType: 'GenerateImageNode' },
  { label: 'Styled image', icon: Brush, nodeType: 'FluxLoRARemoteNode' },
  { label: 'Video', icon: Film, nodeType: 'GenerateVideoNode' },
]
const generateAudioOptions = [
  { label: 'Music', icon: Music, nodeType: 'GenerateMusicNode' },
  { label: 'Speech', icon: Mic, nodeType: 'GenerateSpeechNode' },
]
const generateAudioExpanded = ref(false)
watch(openSubmenu, (v) => { if (v !== 'generate') generateAudioExpanded.value = false })

// Space Type surface → outputs. The surface bakes its own frames and dispatches
// `sailor:addNode` directly (Image or Video node), so the layout only needs
// to own the open/close state of the modal.

// Annotate submenu — FigJam-style overlays on the canvas. Each option fires
// `sailor:addAnnotation`; VueNodeCanvas owns the spawn position and
// per-kind logic (file picker for image, two-click flow for arrow).
const annotateOptions = [
  { label: 'Sticky note', icon: StickyNote, kind: 'sticky',    hint: 'S' },
  { label: 'Checklist',   icon: ListChecks, kind: 'checklist', hint: 'C' },
  { label: 'Image pin',   icon: Image,      kind: 'image' },
  { label: 'Arrow',       icon: ArrowRight, kind: 'arrow',     hint: 'A' },
]
// "More" overflow menu — folds the power-user + annotate actions behind one
// toolbar item. Nodes/Blocks reuse runSidebarItem; annotate options fire
// addAnnotation. (Annotate is no longer a top-level toolbar item.)
const moreOptions = [
  { label: 'Nodes', icon: GitFork, tabId: 'node-library' },
  { label: 'Blocks', icon: Boxes, panel: 'blocks' },
]

function addAnnotation(kind: string) {
  window.dispatchEvent(new CustomEvent('sailor:addAnnotation', { detail: { kind } }))
  openSubmenu.value = null
}

// "Get Started" modal: pops up once per fresh blank project. We track the
// target tab id so the modal is bound to a single tab — switch away and it
// disappears, switch back and it stays gone (once dismissed). Tabs that
// open with a workflowId (recent project, community workflow) skip the
// modal entirely.
const startModalTabId = ref<string | null>(null)
const seenStartModalTabIds = new Set<string>()

watch(() => activeTabId.value, (id) => {
  if (!id) { startModalTabId.value = null; return }
  const tab = tabs.value.find((t) => t.id === id) as any
  // A tab that already has a workflow on the canvas (saved nodes) is NOT blank,
  // even if it was opened without a workflowId (e.g. "Use in new workflow",
  // a generation in progress). Tying the modal to real content — not just the
  // volatile seen-Set — stops it re-appearing over an existing generation.
  const hasSavedContent = docHasContent(savedWorkflows[id])
  const isFreshBlankProject = tab?.type === 'project' && !tab?.workflowId
    && !seenStartModalTabIds.has(id) && !hasSavedContent
  if (isFreshBlankProject) {
    seenStartModalTabIds.add(id)
    if (tab.seedNodeType) {
      // Opened from a homepage medium card — skip the picker and drop the
      // chosen starter generator straight onto the new canvas.
      startModalTabId.value = null
      seedStarterGraph(tab.seedNodeType)
    } else {
      startModalTabId.value = id
    }
  } else {
    // Tab switch → hide the modal (without re-triggering on switch-back).
    startModalTabId.value = null
  }
})

// Real page navigations (e.g. /help) render in the Home tab's page slot —
// switch there so the page is actually visible when a project tab is active.
watch(() => route.path, (p) => {
  if (p !== '/' && activeTab.value?.type !== 'home') setActiveTab('home')
}, { immediate: true })

// Drop a starter generator onto a freshly-opened project. The canvas mounts a
// tick or two after the tab activates, so retry until materializeStartGraph is
// available, then ensure the schema is loaded (it reads object_info) before
// seeding — mirrors the Run path's refreshSchema safety. Both failure paths
// (canvas never mounts, generator type missing from object_info) surface a
// toast instead of leaving the user staring at a blank canvas.
async function seedStarterGraph(nodeType: string, tries = 0) {
  const canvas = vueCanvasRef.value
  if (canvas?.materializeStartGraph) {
    await canvas.refreshSchema?.()
    if (canvas.materializeStartGraph({ generatorNodeType: nodeType }) === false) {
      toast.error('Couldn’t add the starter', { description: `The backend doesn’t provide “${nodeType}”. Check that ComfyUI is running and up to date, then try again from the + menu.` })
    }
  } else if (tries < 40) {
    setTimeout(() => seedStarterGraph(nodeType, tries + 1), 50)
  } else {
    toast.error('Couldn’t set up the project', {
      description: vueNodesEnabled.value
        ? 'The canvas didn’t finish loading. Refresh the page and try again.'
        : 'Turn on Settings → Modern node design to use starter projects.',
    })
  }
}

function onStartModalPick(payload: { nodeType: string; source?: ActionSource }) {
  const sourceNodeType = payload.source ? ARTIFACT_NODE_FOR_SOURCE[payload.source] : undefined
  startModalTabId.value = null
  // Defer one tick so the modal unmounts before we touch the canvas — keeps
  // any focus/scroll state clean and ensures the canvas is fully mounted.
  // Then ensure the schema is loaded before seeding: materializeStartGraph
  // returns false when object_info hasn't arrived yet or lacks the picked
  // generator — mirrors seedStarterGraph's refreshSchema safety, and both
  // failure paths surface a toast rather than staying silent.
  nextTick(async () => {
    const canvas = vueCanvasRef.value
    if (!canvas?.materializeStartGraph) {
      toast.error('Couldn’t set up the project', {
        description: vueNodesEnabled.value
          ? 'The canvas didn’t finish loading. Refresh the page and try again.'
          : 'Turn on Settings → Modern node design to use starter projects.',
      })
      return
    }
    await canvas.refreshSchema?.()
    const ok = canvas.materializeStartGraph({ sourceNodeType, generatorNodeType: payload.nodeType })
    if (ok === false) {
      toast.error('Couldn’t add the starter', { description: `The backend doesn’t provide “${payload.nodeType}”. Check that ComfyUI is running and up to date, then try again from the + menu.` })
    }
  })
}

// Studio tile in the start modal → same routing as the toolbar Studios door.
function onStartModalStudio(opt: { label: string; nodeType?: string; special?: string }) {
  startModalTabId.value = null
  nextTick(() => onLoadOption(opt))
}
function onStartModalSkip() {
  startModalTabId.value = null
}

const activeTool = ref<string>('select')

const activeSidebarItem = ref<string | null>(null)
const vueSidebarOpen = ref(false) // tracks whether ComfyUI left sidebar panel is visible in Vue mode
const vueNodesSidebarOpen = ref(false) // tracks whether the native Nodes sidebar is open in Vue mode
const vueRightPanelOpen = ref(false) // tracks whether Vue right panel (Workflow Overview) is visible
// Node inspector right panel — edits the selected node's mechanical settings.
// Mutually exclusive with the Workflow Overview (both dock right, same slot).
const nodeInspectorOpen = ref(false)
const inspectorNode = computed(() => vueCanvasRef.value?.selectedNode ?? null)
// Opened from a per-node "settings" button (sailor:openInspector). Select the
// node so the inspector binds to it, open the panel, and close the overview
// (they share the right dock).
function handleOpenInspector(e: Event) {
  const id = (e as CustomEvent).detail?.nodeId
  if (id != null) vueCanvasRef.value?.selectNode?.(String(id))
  nodeInspectorOpen.value = true
  vueRightPanelOpen.value = false
}
function toggleWorkflowOverview() {
  vueRightPanelOpen.value = !vueRightPanelOpen.value
  if (vueRightPanelOpen.value) nodeInspectorOpen.value = false
}
const toolboxPanelOpen = ref(false) // tracks whether the Toolbox right panel is visible
const generatorsPanelOpen = ref(false) // tracks whether the Generators panel is visible
const loraLibraryPanelOpen = ref(false) // tracks whether the LoRA Library panel is visible
const charactersPanelOpen = ref(false) // tracks whether the Character Library panel is visible
const blockLibraryPanelOpen = ref(false) // tracks whether the Block Library panel is visible
const assetsPanelOpen = ref(false) // tracks whether the Assets panel is visible
const templatesPanelOpen = ref(false) // tracks whether the Templates gallery panel is visible

// Canvas → Actions panel deep-link: anything on the canvas can dispatch
// `sailor:openActions` with an optional domain to open the panel on that
// tab (selection chips' "All actions…" uses this). ts forces the watcher to
// re-fire on repeated same-domain opens.
const actionsFocusDomain = ref<{ domain: ActionDomain; ts: number } | null>(null)
function handleOpenActions(e: Event) {
  const domain = (e as CustomEvent).detail?.domain
  if (domain) actionsFocusDomain.value = { domain, ts: Date.now() }
  openSubmenu.value = null
  toolboxPanelOpen.value = false
  loraLibraryPanelOpen.value = false
  charactersPanelOpen.value = false
  blockLibraryPanelOpen.value = false
  templatesPanelOpen.value = false
  generatorsPanelOpen.value = true
}

// Whether a sidebar item is currently the "active" one (highlighted).
// Single source of truth for the chevron/button highlight logic — used by
// the template instead of nested ternaries that got unreadable as we added
// more panel types.
function isSidebarItemActive(item: any): boolean {
  if (item?.tool) return activeTool.value === item.tool
  if (item?.panel === 'toolbox') return toolboxPanelOpen.value
  if (item?.panel === 'generators') return generatorsPanelOpen.value
  if (item?.panel === 'loras') return loraLibraryPanelOpen.value
  if (item?.panel === 'characters') return charactersPanelOpen.value
  if (item?.panel === 'blocks') return blockLibraryPanelOpen.value
  if (item?.panel === 'assets') return assetsPanelOpen.value
  if (item?.panel === 'templates') return templatesPanelOpen.value
  if (item?.submenu) return openSubmenu.value === item.submenu || (item.submenu === 'more' && (blockLibraryPanelOpen.value || vueNodesSidebarOpen.value))
  return activeSidebarItem.value === item?.label
}

function toggleSidebarItem(label: string) {
  const item = sidebarItems.find((i) => i.label === label)
  if (item?.action === 'openAssets') {
    openTab({ type: 'assets', label: 'Assets' })
    return
  }
  if (item?.submenu) {
    // Close side panels so the popup isn't competing with them.
    toolboxPanelOpen.value = false
    generatorsPanelOpen.value = false
    loraLibraryPanelOpen.value = false
    charactersPanelOpen.value = false
    blockLibraryPanelOpen.value = false
    templatesPanelOpen.value = false
    openSubmenu.value = openSubmenu.value === item.submenu ? null : (item.submenu as SubmenuName)
    return
  }
  runSidebarItem(item)
}

// Perform a leaf sidebar action (tool / panel / tab). Shared by the toolbar and
// the "More" overflow menu so their behaviour can't drift.
function runSidebarItem(item: any) {
  openSubmenu.value = null
  if (item?.tool) {
    // Deactivate explain if switching away
    if (activeTool.value === 'explain' && item.tool !== 'explain') {
      deactivateExplain()
    }
    activeTool.value = item.tool
    if (item.tool === 'explain') {
      activateExplain()
    }
    else if (!vueNodesEnabled.value) {
      sendToActiveProjectIframe('setCanvasTool', { tool: item.tool })
    }
    // In Vue mode, Select/Hand work natively via Vue Flow
  }
  else if (item?.panel === 'toolbox' || item?.panel === 'generators' || item?.panel === 'loras' || item?.panel === 'characters' || item?.panel === 'blocks' || item?.panel === 'assets' || item?.panel === 'templates') {
    // Left canvas panels are mutually exclusive — opening one closes the rest.
    const refs = {
      toolbox: toolboxPanelOpen,
      generators: generatorsPanelOpen,
      loras: loraLibraryPanelOpen,
      characters: charactersPanelOpen,
      blocks: blockLibraryPanelOpen,
      assets: assetsPanelOpen,
      templates: templatesPanelOpen,
    }
    const target = refs[item.panel as keyof typeof refs]
    const wasOpen = target.value
    for (const r of Object.values(refs)) r.value = false
    target.value = !wasOpen
  }
  else if (item?.tabId) {
    const wasActive = activeSidebarItem.value === item.label
    activeSidebarItem.value = wasActive ? null : item.label

    if (vueNodesEnabled.value) {
      // Vue mode: use native panels where available, iframe for the rest
      if (item.tabId === 'node-library') {
        vueNodesSidebarOpen.value = !wasActive
        vueSidebarOpen.value = false
      } else {
        vueNodesSidebarOpen.value = false
        sendToActiveProjectIframe('toggleSidebarTab', { tabId: item.tabId })
        vueSidebarOpen.value = !wasActive
      }
    } else {
      sendToActiveProjectIframe('toggleSidebarTab', { tabId: item.tabId })
    }
  }
}

const minimapActive = ref(false)

function zoomIn() {
  if (vueNodesEnabled.value) { vueCanvasRef.value?.zoomIn?.() }
  else { sendToActiveProjectIframe('canvasZoom', { direction: 'in' }) }
}
function zoomOut() {
  if (vueNodesEnabled.value) { vueCanvasRef.value?.zoomOut?.() }
  else { sendToActiveProjectIframe('canvasZoom', { direction: 'out' }) }
}
function zoomReset() {
  if (vueNodesEnabled.value) { vueCanvasRef.value?.fitView?.() }
  else { sendToActiveProjectIframe('canvasZoom', { direction: 'reset' }) }
}
function toggleMinimap() {
  minimapActive.value = !minimapActive.value
  if (!vueNodesEnabled.value) sendToActiveProjectIframe('toggleMinimap')
}

function sendToActiveProjectIframe(action: string, payload?: any) {
  const iframe = getSharedIframe()
  if (iframe?.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'sailor', action, ...payload }, '*')
  }
}

// Surface a ComfyUI node_errors validation map the same way the bridge
// 'queue_error' postMessage does — per-node summary toast + clear run state so
// spinners never hang. Shared by the bridge handler and the direct-execution
// path (whose queue() resolves with { node_errors } on a /prompt 400).
//
// `refusal`/`statusCode` (direct-exec path only — QueueResult.refusal) route
// through the SAME describeQueueRefusal() the bridge's queue_error handler
// uses (VueNodeCanvas.vue), so a metering refusal (moderation/credits/
// ownership/paused) gets the server's own sentence + the moderation
// policy-link action here too, instead of the generic "Couldn't start run"
// fallback (Stage 8 fix — direct execution is the ONLY path hosted mode
// actually takes, per useDirectExecutionEnabled.ts).
function surfaceQueueError(nodeErrors: any, fallbackMessage?: string, opts?: { silent?: boolean; refusal?: boolean; statusCode?: number }) {
  clearQueueWatchdog()
  if (!opts?.silent) {
    const refusal = describeQueueRefusal({ refusal: opts?.refusal, statusCode: opts?.statusCode, message: fallbackMessage })
    if (refusal) {
      toast.error(refusal.title, {
        description: refusal.description,
        ...(refusal.policyLink ? { action: { label: 'Content policy', onClick: () => window.open('/content-policy', '_blank') } } : {}),
      })
    } else {
      const { description } = summarizeNodeErrors(nodeErrors)
      if (description) {
        toast.error('Workflow validation failed', { description })
      } else {
        const msg = fallbackMessage || 'The canvas could not start this run.'
        toast.error('Couldn’t start run', { description: String(msg).slice(0, 160) })
      }
    }
  }
  // Clear any pending run state so spinners don't hang.
  if (activeTab.value?.type === 'project') updateTabStatus(activeTab.value.id, 'idle')
  currentRunSilent.value = false
}

// Dev-only shadow parity: build OUR prompt for `workflow`, ask the bridge iframe
// for ITS graphToPrompt output, and record any divergence. Strictly
// fire-and-forget — any failure (build throw, no iframe, no/late reply) is
// swallowed so the run is never blocked, delayed, or failed by this.
function requestShadowParity(workflow: any, label: string) {
  let ours: import('~/lib/graph/graphToPrompt').ApiPrompt
  try {
    ours = graphToPrompt(workflow, objectInfo.value)
  } catch {
    // Our builder disagreeing is itself a real divergence, but with nothing to
    // compare against we can't record it here — the flag-ON path surfaces build
    // failures directly. Silently skip parity for this run.
    return
  }
  const iframe = getSharedIframe()
  if (!iframe?.contentWindow) return

  let done = false
  const handler = (event: MessageEvent) => {
    if (done) return
    if (event.data?.type !== 'sailor-bridge' || event.data?.event !== 'prompt_data') return
    done = true
    window.removeEventListener('message', handler)
    try {
      const result = event.data.prompt
      // window.app.graphToPrompt() returns { workflow, output }; the API prompt
      // is `.output`. Fall back to the raw result if a build already unwrapped it.
      const theirs = result?.output ?? result
      if (theirs) useShadowParity().record(ours, theirs, label)
    } catch (err) {
      console.warn('[shadow-parity] record failed (ignored)', err)
    }
  }
  window.addEventListener('message', handler)
  iframe.contentWindow.postMessage({ type: 'sailor', action: 'getPrompt' }, '*')
  // Give up quietly if the reply never comes — a missing prompt_data is fine.
  setTimeout(() => {
    if (!done) {
      done = true
      window.removeEventListener('message', handler)
    }
  }, 4000)
}

// Run workflow from Vue canvas — loads into bridge iframe, then queues via bridge.
// When `targetIds` is provided, runs only that subset (plus upstream deps).
// Forgiving filtering happens via buildFilteredWorkflow which mutes everything
// outside the keep set; LiteGraph already honors mode=2 at queue time.
// Style injection (FLUX LoRA prompt fold + GenerateImageNode's name-resolved
// style_block write) lives in ~/lib/graph/styleInject.ts so it's unit-testable
// — the run path calls it on the outgoing workflow copy only (see assembleTake).

async function runVueWorkflow(
  targetIds?: string[],
  opts: { rerollScope?: 'self' | 'variation', direction?: 'downstream', live?: boolean, skipCostConfirm?: boolean, costConfirmIterations?: number, takes?: number } = {},
): Promise<boolean> {
  if (!vueCanvasRef.value?.getWorkflow) {
    console.warn('[Run] no getWorkflow on vueCanvasRef')
    toast.error('Canvas not ready', { description: 'Give it a moment and try again.' })
    return false
  }

  // Ensure the cached /object_info schema is current (the mount-time fetch can
  // predate the backend registering Compositor z/mask inputs) and heal any
  // Compositor whose saved widget array drifted, before we build the workflow.
  try {
    await vueCanvasRef.value.refreshSchema?.()
  } catch (err) {
    console.error('[Run] schema refresh failed', err)
  }

  // Auto-materialize Image sinks for any node with a dangling IMAGE output.
  // For full-graph Run (no targetIds), every active node is a candidate; the
  // canvas's own guards (skip Image self, skip already-wired outputs) keep
  // this from being too aggressive. handleRunFiltered does the same dance for
  // targeted Runs before calling this function — the global Run button skips
  // that wrapper and calls us directly, so we have to handle it here too.
  if (!targetIds?.length) {
    const all = vueCanvasRef.value.getNodes?.() || []
    const activeIds = all
      .filter((n: any) => (n.data?.mode ?? 0) !== 2)
      .map((n: any) => n.id)
    vueCanvasRef.value.materializeAutoImageSinks?.(activeIds)
  }

  const useDirect = directExecutionEnabled.value
  // Parallel takes: N fresh-seeded runs at once, direct-execution only. Each
  // take re-invokes getFilteredWorkflow (which re-rolls seeds per call) and the
  // full prep→graphToPrompt assembly below, so the workers get distinct seeds
  // but otherwise-identical graphs. Absent/1/non-direct ⇒ exactly one pass,
  // byte-identical to before.
  const takeCount = (useDirect && (opts.takes ?? 1) > 1) ? Math.floor(opts.takes as number) : 1

  // Pick the worker for the tab being run (always 0 when the pool is off), so
  // separate canvases queue to separate ComfyUI servers and run concurrently.
  // Once-only (worker assignment for parallel takes is decided by queueParallel).
  const runTabId = activeTab.value?.id || ''
  const workerIdx = workerForTab(runTabId)
  if (poolEnabled.value && runTabId) workerRunningTab[workerIdx] = runTabId
  // Runs are always queued from the displayed canvas of the run tab.
  const runDoc = savedWorkflows[runTabId]
  // The canvas this run is dispatched from — stamped on every registerRun below
  // (Task 6 Part B) so VueNodeCanvas can route per-run events to the right canvas
  // even across concurrent runs. Same value drives runningCanvasByWorker.
  const runCanvasId = isProjectDoc(runDoc) ? runDoc.activeCanvasId : null
  runningCanvasByWorker[workerIdx] = runCanvasId

  // Snapshot THIS run's own node catalog at dispatch time (the run's displayed
  // canvas). Written onto each registered run's estimateNodes so execution_complete
  // prices the run's executed-node-id SET against ITS OWN nodes — not the active
  // tab's currently-displayed nodes, which collide by id across canvases. Captured
  // once here (dispatch is single-canvas) and shared across parallel takes of this run.
  const runEstimateNodes: any[] = vueCanvasRef.value!.getNodes?.() || []

  // Load workflow into that worker's LiteGraph, then queue. Once-only — the
  // hidden iframe only backs dev shadow-parity, so loading the last take's
  // graph is sufficient.
  // Hosted mounts no engine iframe at all, and its runs never touch one (the
  // bridge section below is skipped and dispatch is always direct), so a null
  // here is expected rather than a lost connection. Tier 1 (bridge retirement):
  // direct execution now runs the same way in DEV — `useDirect` is always true,
  // no iframe is mounted, and dispatch is direct — so the guard skips it too.
  // Only the legacy bridge path (neither hosted nor direct) still needs an iframe.
  const iframe = getWorkerIframe(workerIdx)
  if (!hostedShell && !useDirect && !iframe?.contentWindow) {
    console.error('[Run] bridge iframe not found or not ready')
    toast.error('ComfyUI not ready', { description: 'Lost the canvas connection — try reloading the page.' })
    return false
  }

  // Assemble one take: roll fresh seeds (getFilteredWorkflow does this per call),
  // run the full prep chain + build the direct ApiPrompt. Returns the plain
  // workflow + (direct-mode) ApiPrompt, or 'abort' on a fatal per-take failure
  // that should stop the whole run. `isFirst` gates once-only gestures
  // (cost-confirm dialog) so a takes×N run confirms cost a single time.
  // Cost guard, HOISTED OUT OF the assemble-run lock (liveness fix): confirm the
  // estimate BEFORE acquiring the lock so an unanswered cost-confirm dialog can't
  // hold the global assemble lock and silently queue every other run behind it
  // (which would also make the cost-confirm FIFO queue unreachable). The estimate
  // needs only the live nodes + targetIds — NOT the assembled workflow — so it runs
  // here without any lock held. Preserves the exact confirm semantics of the old
  // in-assembly gate: once per run (not per take), the takes×costConfirmIterations
  // multiply, live/skip runs never prompt, cancel → abort before any assembly.
  if (!opts.skipCostConfirm && !opts.live) {
    const vnodes = vueCanvasRef.value!.getNodes?.() || []
    // The nodes about to run. For a FULL run (no targetIds): every active
    // (mode !== 2) node. For a TARGETED/filtered run: the transitive keep-set —
    // the target ids PLUS every upstream producer they depend on (or, for a
    // downstream "run here → end" run, the forward cone + its inputs). Pricing
    // only the target ids alone under-quotes any filtered run that re-executes a
    // billable UPSTREAM generator (the default "rebuild from start → here" scope
    // re-rolls all seeds with no freeze), so those producers must be in the
    // estimate. This mirrors the pre-hoist gate, which priced the filtered
    // workflow's nodes (buildFilteredWorkflow → collectKeepSet). Computed here as
    // a PURE upstream/downstream graph walk over the live edges — no seed re-roll,
    // no getFilteredWorkflow (which mutates seeds), so the confirm gate stays free
    // of side effects and outside the assemble-run lock.
    let targetSet: Set<string> | null = null
    if (targetIds?.length) {
      const edges = vueCanvasRef.value!.getEdges?.() || []
      // Synthesize collectKeepSet's link-tuple view from Vue Flow edges:
      // [linkId, originId, originSlot, targetId, targetSlot, type]. Only origin
      // (idx 1) and target (idx 3) are read by the keep-set walk.
      const linkView = (edges as any[])
        .map((e: any) => [0, Number(e.source), 0, Number(e.target), 0, '*'] as any[])
        .filter((l: any[]) => Number.isFinite(l[1]) && Number.isFinite(l[3]))
      const ids = targetIds.map(Number).filter(Number.isFinite)
      const keep = opts.direction === 'downstream'
        ? collectKeepSetDownstream({ links: linkView } as any, ids)
        : collectKeepSet({ links: linkView } as any, ids)
      targetSet = new globalThis.Set([...keep].map((id) => String(id)))
    }
    // Same adapter the Run-button estimate uses (it already drops muted nodes),
    // so the confirm dialog and the node badges read the same widget values.
    const estInput = vueNodesToEstimateInput(
      (vnodes as any[]).filter((v: any) => !targetSet || targetSet.has(String(v.id))),
    )
    const single = estimateUsdForNodes(estInput, { hosted: hostedShell })
    if (single) {
      const iterations = Math.max(1, (opts.costConfirmIterations || 1) * takeCount)
      // Credits scale with iterations exactly as dollars do — each iteration is
      // its own graph submit, so its own base_render is charged again.
      const est: CostEstimate = {
        ...single,
        usd: single.usd * iterations,
        ...(single.hostedCredits != null ? { hostedCredits: single.hostedCredits * iterations } : {}),
      }
      if (est.usd >= costConfirmThresholdUsd() && !(await confirmRunCost(est, iterations))) {
        return false // cancelled at the cost gate — return before acquiring the lock
      }
    }
  }

  type AssembledTake = { plainWorkflow: any; directPrompt: import('~/lib/graph/graphToPrompt').ApiPrompt | null }
  const assembleTake = async (): Promise<AssembledTake | 'abort'> => {
    const workflow = targetIds?.length && vueCanvasRef.value!.getFilteredWorkflow
      ? vueCanvasRef.value!.getFilteredWorkflow(targetIds, opts)
      : vueCanvasRef.value!.getWorkflow(opts.live ? { reroll: false } : undefined)
    if (!workflow?.nodes?.length) {
      console.warn('[Run] workflow has no nodes')
      toast.error('Nothing to run', { description: 'No runnable nodes were found for this action.' })
      return 'abort'
    }

    // Deep-copy to strip Vue reactivity proxies (postMessage can't clone Proxy objects)
    let plainWorkflow = JSON.parse(JSON.stringify(workflow))

    // Stamp the tab's stable project UUID so history entries can be grouped
    if (activeTab.value.projectUuid) {
      plainWorkflow.extra = { ...(plainWorkflow.extra || {}), projectUuid: activeTab.value.projectUuid }
    }

    // Prepend each FluxLoRARemoteNode's "Style" field (a node property, NOT a
    // ComfyUI input — keeps the schema stable) into its prompt widget at submit
    // time, and write each GenerateImageNode's composed block into its hidden
    // style_block widget (resolved BY NAME from the objectInfo widget order —
    // its prompt is not at index 0). The live node's widgets stay clean (we
    // only mutate this copy).
    injectLoraStyleIntoPrompt(plainWorkflow, objectInfo.value)

    // Bake any Compositor text/shape overlays into uploaded image layers and
    // wire them into the workflow (mutates plainWorkflow in place).
    try {
      await vueCanvasRef.value!.injectCompositorOverlays?.(plainWorkflow)
    } catch (err) {
      console.error('[Run] compositor overlay injection failed', err)
      toast.error('Frame compositing failed', { description: String((err as any)?.message || err).slice(0, 120) })
    }

    // Auto-wire any "protect in blend" layers into a downstream Blend Scene.
    try {
      vueCanvasRef.value!.injectProtectMaskWiring?.(plainWorkflow)
    } catch (err) {
      console.error('[Run] protect-mask wiring failed', err)
    }

    // Push each Timeline node's editor state (keyframes, multi-track clips) into
    // its edit_state widget so node-run renders what the editor shows. Async:
    // it may force a fresh /object_info fetch to self-heal a stale schema cache,
    // and throws (→ toast with the remedy) if the widget is still missing.
    try {
      await vueCanvasRef.value!.injectTimelineEditState?.(plainWorkflow)
    } catch (err) {
      console.error('[Run] timeline edit_state injection failed', err)
      toast.error('Timeline state failed', { description: String((err as any)?.message || err).slice(0, 160) })
    }

    // Push each Compositor node's baked motion (Kinetic Slates PNG sequence)
    // into its motion_params widget so the backend returns the baked animation
    // as its image batch + video output instead of the static composite.
    try {
      await vueCanvasRef.value!.injectCompositorMotionParams?.(plainWorkflow)
    } catch (err) {
      console.error('[Run] compositor motion_params injection failed', err)
      toast.error('Frame motion state failed', { description: String((err as any)?.message || err).slice(0, 160) })
    }

    // Push each Compositor node's wired-layer cloners into their layer{i}_cloner
    // widgets so the rendered output matches the editor's cloned preview.
    try {
      await vueCanvasRef.value!.injectCompositorCloners?.(plainWorkflow)
    } catch (err) {
      console.error('[Run] compositor cloner injection failed', err)
      toast.error('Frame cloner state failed', { description: String((err as any)?.message || err).slice(0, 160) })
    }

    // Fold the project's active brand kit under every SmartLayout node's wired
    // brand, so Run output matches the kit-themed editor preview. No active
    // kit ⇒ no-op (widgets untouched, byte-identical submit).
    try {
      const kit = brandLib.activeKit.value
      await vueCanvasRef.value!.injectSmartLayoutBrand?.(plainWorkflow, kit ? brandKitToKv(kit) : '')
    } catch (err) {
      console.error('[Run] smart layout brand_kit injection failed', err)
      toast.error('Brand kit injection failed', { description: String((err as any)?.message || err).slice(0, 160) })
    }

    // Bake Collection-bound layout vars (element↔column bindings) into each
    // SmartLayout's layout widget, resolved against the collection's preview
    // row — the Collection node is frontend-only and gets stripped below, so
    // without this the backend renders the raw `{{ props.… }}` tokens. Must
    // run BEFORE stripFrontendOnlyNodes (the Collection holds the values).
    // No bindings ⇒ no-op (byte-identical submit).
    try {
      vueCanvasRef.value!.injectSmartLayoutCollectionVars?.(plainWorkflow)
    } catch (err) {
      console.error('[Run] smart layout collection vars injection failed', err)
      toast.error('Layout vars injection failed', { description: String((err as any)?.message || err).slice(0, 160) })
    }

    // Resolve `@refs` (prompt tokens + image-loader bindings) into the outgoing
    // workflow. No refs registered ⇒ no-op (byte-identical submit).
    const assetReg = activeProjectDoc.value?.assetRegistry
    if (assetReg && Object.keys(assetReg).length) {
      try {
        await vueCanvasRef.value!.injectAssetRegistry?.(plainWorkflow, assetReg)
      } catch (err) {
        console.error('[Run] @refs injection failed', err)
      }
    }

    // Promote any standalone artifact image still pointing at an ephemeral temp
    // preview into a durable input upload — ComfyUI wipes temp/ on restart, so a
    // wired result would otherwise fail validation ("Invalid image file … [temp]").
    // If the bytes are already gone, abort with a clear message instead of letting
    // the backend reject the run cryptically.
    try {
      await promoteTempImageInputs(plainWorkflow)
    } catch (err) {
      console.error('[Run] temp image promotion failed', err)
      toast.error("Couldn't prepare source image", { description: String((err as any)?.message || err).slice(0, 200) })
      return 'abort'
    }

    // Frontend-only nodes (studios with no /object_info entry — Collection,
    // SpaceType, GradientStudio, etc.) never execute server-side. Filtered runs
    // already exclude them (buildFilteredWorkflow only keeps an explicit target
    // set), but a global Run loads the full graph, and the bridge iframe's own
    // graphToPrompt aborts the ENTIRE run the instant it hits a class_type-less
    // node ("Node 'X' has no class_type"). Strip them from this run-only copy —
    // never from anything a save path might still reference.
    const { workflow: strippedWorkflow, removedTypes } = stripFrontendOnlyNodes(plainWorkflow, FRONTEND_ONLY_NODE_TYPES)
    if (removedTypes.length) {
      plainWorkflow = strippedWorkflow
      console.log('[Run] excluded frontend-only node(s) from execution:', removedTypes)
    }
    // Execution-boundary guard: VARS links (Collection → Smart Layout) are kept
    // all the way through getWorkflow/getFilteredWorkflow so saves/reloads keep
    // the wire — this run-only copy is the one place they get stripped, since
    // Collection has no backend class_type and a surviving VARS link would abort
    // graphToPrompt with "No link found in parent graph".
    stripVarsLinks(plainWorkflow as any)

    // One-shot promotes: substitute the take snapshot for any node with a pending
    // promote. Registered by ArtifactImageNode.promoteTake just before it fires
    // runFiltered. NOTE: consumption here is peek-free — a promote submitted in
    // draft mode still renders final for that node. The actual consume (clearing
    // the registry) happens at result time when the take is tagged (Task 4).
    // Placement: this must run AFTER every early-return gate above (cost-confirm
    // cancel, temp-image-promotion failure, iframe-not-ready) so an aborted run
    // never leaves the entry in promoteByNode to be wrongly consumed by the
    // node's next ordinary re-roll — and immediately before the actual submit.
    const vnodesForPromote = vueCanvasRef.value!.getNodes?.() || []
    applyPendingPromotes(plainWorkflow, vnodesForPromote, (nodeId) => peekPendingPromote(nodeId))

    const activeCount = (plainWorkflow.nodes as any[]).filter((n: any) => (n.mode ?? 0) !== 2).length
    console.log('[Run] sending workflow with', plainWorkflow.nodes.length, 'nodes to worker', workerIdx,
      targetIds?.length ? `(filtered: ${activeCount} active, ${targetIds.length} targets)` : '')
    // Direct-execution branch (Settings › "Direct execution (beta)", default OFF).
    // When ON we build the ComfyUI API prompt in-app and POST it straight to
    // /prompt via the native WS channel, bypassing the bridge iframe's queuePrompt.
    // The builder can throw (UnknownNodeTypeError, subgraph guards) — surface that
    // and abort BEFORE any dispatch so no spinner is left hanging.
    let directPrompt: import('~/lib/graph/graphToPrompt').ApiPrompt | null = null
    if (useDirect) {
      try {
        directPrompt = graphToPrompt(plainWorkflow, objectInfo.value)
      } catch (err) {
        const msg = err instanceof UnknownNodeTypeError
          ? err.message
          : String((err as any)?.message || err)
        console.error('[Run] direct prompt build failed', err)
        toast.error("Couldn't build workflow", { description: msg.slice(0, 200) })
        // Abort cleanly — nothing was dispatched, so just clear run state.
        if (activeTab.value?.type === 'project') updateTabStatus(activeTab.value.id, 'idle')
        currentRunSilent.value = false
        return 'abort'
      }
    }
    return { plainWorkflow, directPrompt }
  }

  // Assembly critical section (audit R1, scope-narrowed R3). Seeds are already
  // safe (each take snapshots them synchronously before any await), but the
  // assembly below reads/mutates LIVE state and the promote registry AFTER
  // await points — applyPendingPromotes/peekPendingPromote. Two overlapping
  // runs interleaving those reads could cross-consume each other's promote
  // marks. Serialize ONLY the assemble window on ONE global key so overlapping
  // runs assemble one-at-a-time.
  //
  // SCOPE: this lock covers ONLY assembly — producing firstTake + extraTakes
  // (plainWorkflow + directPrompt) plus the once-only cost-confirm gate. It
  // does NOT cover dispatch. The DISPATCH (sendLoadWorkflow + bridge queuePrompt
  // post, or direct queueSmart/queueParallel) operates on the already-assembled
  // artifacts and runs AFTER the lock releases. This matters because queueSmart's
  // spill path awaits an /api/pool/ensure probe (up to 35s on a wedged cold
  // boot) BEFORE the /prompt POST — holding the global lock across that probe
  // would serialize dispatch across all concurrent runs and defeat the
  // back-to-back overlap the epic built. The synchronous reserve() (Task 6)
  // already orders spill claims without needing the lock. So: assemble under
  // the lock, release, then dispatch unlocked.
  type Assembled = { firstTake: AssembledTake; extraTakes: AssembledTake[] }
  const assembled = await withKeyedLock('assemble-run', async (): Promise<Assembled | 'abort'> => {
    // Take 1 — assemble. The cost-confirm gate already ran (hoisted) BEFORE this
    // lock, so no user-interaction await lives inside the lock: an open dialog can
    // no longer stall every other run's assembly.
    const firstTake = await assembleTake()
    if (firstTake === 'abort') return 'abort'
    // Extra parallel takes (direct-mode only) — each with its own fresh seeds.
    const extraTakes: AssembledTake[] = []
    for (let t = 1; t < takeCount; t++) {
      const nextTake = await assembleTake()
      if (nextTake === 'abort') return 'abort'
      extraTakes.push(nextTake)
    }
    return { firstTake, extraTakes }
  })
  if (assembled === 'abort') return false
  // LOCK RELEASED. Dispatch below runs UNLOCKED on the already-assembled
  // artifacts — the pool-ensure probe inside queueSmart no longer blocks a
  // second run's assembly.
  const { firstTake, extraTakes } = assembled
  const { plainWorkflow, directPrompt } = firstTake

  // The worker iframe holds ONE graph at a time, and bridge-mode queueing is a
  // two-step critical section (loadWorkflow → delay → queuePrompt) against it.
  // Overlapping runs on the same worker used to interleave those steps: run B's
  // load overwrote run A's graph before A's queuePrompt fired, so one node's
  // graph queued twice and the other's never. Serialize the iframe section per
  // worker; direct-mode queueing (own pre-built ApiPrompt, no iframe read at
  // queue time) stays outside the lock and still overlaps freely.
  //
  // Hosted skips this whole section: there IS no worker iframe (the template
  // does not mount one — no engine origin is reachable from a hosted browser),
  // so sendLoadWorkflow would await a bridge that never becomes ready. Hosted
  // always runs direct — useDirectExecutionEnabled forces the setting ON.
  // Tier 1 (bridge retirement): `useDirect` is now always true (direct execution
  // is the only dispatch path), so this whole iframe critical section is skipped
  // in dev exactly as it already is in hosted — there is no bridge iframe to load
  // the workflow into or to queuePrompt against. Gated on `!useDirect` so a
  // temporary revert of the direct-execution flag restores the bridge path.
  if (!hostedShell && !useDirect) await withKeyedLock(`bridge-run:${workerIdx}`, async () => {
    await sendLoadWorkflow(plainWorkflow, workerIdx)

    // Dev-only shadow parity: on EVERY run (direct or bridge), ask the freshly
    // loaded iframe for its own graphToPrompt output and compare it to ours.
    // Fire-and-forget: never blocks, delays, or fails the run.
    if (import.meta.dev) {
      try {
        requestShadowParity(plainWorkflow, `run:${Date.now()}`)
      } catch (err) {
        console.warn('[Run] shadow parity request failed (ignored)', err)
      }
    }

    if (!useDirect) {
      await new Promise(r => setTimeout(r, 800))
      console.log('[Run] sending queuePrompt to worker', workerIdx)
      iframe?.contentWindow?.postMessage({ type: 'sailor', action: 'queuePrompt' }, '*')
      // Explicit (non-live) runs get a no-response watchdog. Live-preview runs fire
      // continuously and silently by design, so they're exempt from the toast.
      // Armed inside the lock so queued-behind runs measure from their own
      // queue time, not from click time.
      if (!opts.live) armQueueWatchdog(runTabId)
    }
  })

  if (useDirect) {
    try {
      // Register a returned run + arm its per-run watchdog. Each parallel take
      // lands on the worker queueParallel actually assigned it (res.worker),
      // NOT the tab's own workerIdx — that's why QueueResult carries `worker`.
      const registerResult = (res: import('~/composables/useDirectExecution').QueueResult) => {
        if (!res.prompt_id) return
        // Pass res.reservationId so the synchronous reservation (queueSmart/
        // queueParallel claimed at worker-pick time) UPGRADES to a real run
        // instead of double-counting. canvasId (Part B) lets per-run event
        // routing find this run's canvas even on terminal events.
        registerRun(
          { promptId: res.prompt_id, tabId: runTabId, live: !!opts.live, worker: res.worker ?? workerIdx, canvasId: runCanvasId },
          res.reservationId,
        )
        // Stash the run's OWN node catalog (captured at dispatch) so its cost
        // tally at execution_complete prices against these, not the active tab's
        // displayed nodes (which collide by id across canvases). Registered runs
        // only — must follow registerRun so it lands in the registered RunState.
        perRun(res.prompt_id).estimateNodes = runEstimateNodes
        // Explicit (non-live) runs get a per-run no-response watchdog. Live-preview
        // runs fire continuously and silently by design, so they're exempt.
        if (!opts.live) armDirectRunWatchdog(res.prompt_id, runTabId)
      }
      if (takeCount > 1) {
        // Parallel takes: fan N fresh-seeded prompts across the cloud pool.
        // queueParallel decides worker assignment internally (and falls back to
        // sequential-on-main when the pool is unavailable/ineligible). Register
        // each success; surface the first failure once (aggregated).
        console.log(`[Run] queueing ${takeCount} parallel takes directly (bypassing bridge)`)
        const items = [firstTake, ...extraTakes].map((tk) => ({
          prompt: tk.directPrompt!,
          workflow: tk.plainWorkflow,
        }))
        const results = await direct.queueParallel(items, { objectInfo: objectInfo.value })
        const failed = results.find((r) => (r.node_errors && Object.keys(r.node_errors).length) || r.error)
        if (failed) surfaceQueueError(failed.node_errors, failed.error, { refusal: failed.refusal, statusCode: failed.statusCode })
        for (const res of results) {
          if ((res.node_errors && Object.keys(res.node_errors).length) || res.error) continue
          registerResult(res)
        }
      } else {
        console.log('[Run] queueing prompt directly (bypassing bridge)')
        // queueSmart: main while idle; spills a pool-eligible run to a pool
        // worker when main is busy, so back-to-back single runs overlap.
        const res = await direct.queueSmart(directPrompt!, plainWorkflow, { objectInfo: objectInfo.value })
        const hasNodeErrors = res.node_errors && Object.keys(res.node_errors).length
        if (hasNodeErrors || res.error) {
          // Any failure (structured node_errors OR a plain error message from a
          // 400/5xx/network drop) surfaces immediately through the same path the
          // bridge 'queue_error' takes — red-ring + toast — and clears run state,
          // instead of resolving silently and only tripping the ~15s watchdog.
          surfaceQueueError(res.node_errors, res.error, { refusal: res.refusal, statusCode: res.statusCode })
        } else {
          // Cold-boot spill fallback (audit R2): the run wanted a pool worker
          // but /api/pool/ensure rejected/timed out (wedged --cpu boot), so it
          // ran on main instead. Surface that once so the user isn't left
          // wondering why a "spilled" run landed on the main server. The run
          // itself still registered + queued fine, so this is informational.
          if (res.fellBackToMain) {
            toast.warning('Couldn’t start a worker — running on the main server', {
              description: 'A background worker didn’t come up in time. Your run is queued on the main server.',
            })
          }
          registerResult(res)
        }
      }
    } catch (err) {
      console.error('[Run] direct queue failed', err)
      // Backstop for a throw that escapes queueSmart/queueParallel's own
      // internal catch (queue()'s /prompt POST failure normally resolves as a
      // QueueResult, handled above) — route it through the same
      // surfaceQueueError() so a metering refusal shape here ALSO gets the
      // server's message + policy-link instead of a generic ofetch summary.
      // isH3RefusalBody checks the TYPE of `error` (object = ComfyUI
      // validation, boolean `true` = Nitro-serialized h3 refusal) rather than
      // its truthiness — a plain `!body.error` check is truthy for both
      // shapes and misclassifies a real refusal as a ComfyUI failure.
      const body = (err as any)?.data
      const refusal = isH3RefusalBody(body)
      const statusCode = refusal && typeof body.statusCode === 'number' ? body.statusCode : undefined
      const message = refusal ? body.message : String((err as any)?.message || err)
      surfaceQueueError(null, message, { refusal, statusCode })
    }
  }

  // Bring focus back to the Vue Flow canvas. Without this, the hidden bridge
  // iframe sometimes retains focus after the postMessage handshake, and on
  // macOS the OS routes subsequent pinch-zoom gestures to whatever frame
  // holds focus — meaning the Vue canvas silently loses pinch-zoom until
  // a full reload. The canvas root carries tabindex="-1" specifically so
  // we can pull focus here without the iframe holding on. Skip if the user
  // is actively typing — that intent overrides ours.
  requestAnimationFrame(() => {
    const ae = document.activeElement
    if (ae instanceof Element && ae.matches('input, textarea, [contenteditable]')) return
    const root = document.querySelector('.vue-node-canvas-root') as HTMLElement | null
    root?.focus({ preventScroll: true })
  })
  return true
}

// Filtered-run events from the canvas context menu (Run Group, Run Selection).
// Also fired by per-node Run buttons on individual nodes. Before queueing,
// we ask the canvas to materialize an `Image` artifact card for every
// dangling IMAGE output among the targets — that's where the execution
// result lands. No-op for targets whose outputs are already wired.
async function handleRunFiltered(e: Event) {
  const detail = (e as CustomEvent).detail
  const targetIds = detail?.targetIds as string[] | undefined
  if (!targetIds?.length) return
  const rerollScope = detail?.rerollScope as 'self' | undefined
  // 'downstream' = run this node + everything it feeds (push its current result
  // through the rest of the graph). Default/undefined = the upstream walk.
  const direction = detail?.direction as 'downstream' | undefined
  // Parallel takes gesture: 'Re-roll ×4 (parallel)' passes takes:4 so the
  // dispatch site fans out N fresh-seeded runs at once across the cloud pool.
  const takes = detail?.takes as number | undefined
  // `live` runs are auto-previews (e.g. saving a Smart Layout): scope the run to
  // just these nodes (+ cached upstream), and skip the cost confirm / watchdog /
  // text-autofill dance that an explicit Run does.
  const live = detail?.live === true
  // Scoped dispatches (e.g. the prompt-bar sketch pad) can opt out of the cost
  // gate — the sketch tier is cheap and confirms would break the instant flow.
  const skipCostConfirm = detail?.skipCostConfirm === true
  const expanded = vueCanvasRef.value?.materializeAutoImageSinks?.(targetIds) ?? targetIds
  // Bake any frontend-only studio upstream of the targets first: the run strips
  // studios (no backend class_type), so without this the downstream image node
  // runs with a null input and renders nothing ("studio doesn't render").
  await vueCanvasRef.value?.bakeUpstreamStudios?.(expanded)
  if (!live && !skipCostConfirm && await maybeRunWithTextAutofill(expanded, { rerollScope, direction })) return
  runVueWorkflow(expanded, { rerollScope, live, direction, takes, skipCostConfirm })
}
async function handleRunAll() {
  // Auto-sink materialization lives inside runVueWorkflow now (so the
  // top-right Run button, which calls it directly, also benefits).
  // Bake every frontend-only studio first — a global Run strips them, so an
  // un-baked studio's downstream image node would otherwise run null-input.
  await vueCanvasRef.value?.bakeUpstreamStudios?.()
  if (await maybeRunWithTextAutofill(undefined)) return
  runVueWorkflow()
}

// Awaits the next `execution_complete` event from the bridge. Resolves on
// the first one that arrives — callers must invoke this *before* queueing
// the prompt they care about, or they'll latch onto a stale completion.
function awaitExecutionComplete(timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler)
      reject(new Error('execution_complete timeout'))
    }, timeoutMs)
    function handler(event: MessageEvent) {
      if (event.data?.type !== 'sailor-bridge') return
      if (event.data.event !== 'execution_complete' && event.data.event !== 'execution_error') return
      clearTimeout(timer)
      window.removeEventListener('message', handler)
      resolve()
    }
    window.addEventListener('message', handler)
  })
}

// Auto-fill on Run: if the workflow contains a Text artifact node whose
// `source` input is wired AND has empty entry slots, run the workflow once
// per empty slot — each iteration clears the text widget so the upstream
// value flows through, then we capture the executed text into entries[i].
// Returns true if it handled the run (caller should skip its normal path).
let textAutofillRunning = false
async function maybeRunWithTextAutofill(targetIds?: string[], opts: { rerollScope?: 'self', direction?: 'downstream' } = {}): Promise<boolean> {
  if (textAutofillRunning) return false
  const canvas = vueCanvasRef.value
  if (!canvas?.getNodes || !canvas?.getEdges) return false

  const all = canvas.getNodes() as any[]
  const edges = canvas.getEdges() as any[]

  // Candidate: Text node with `source` connected + ≥1 empty slot. If the
  // user explicitly filtered the run (Run from Selection etc.), restrict
  // candidates to the kept set so we don't surprise them with side-effects
  // on unrelated parts of the graph.
  const allowed = targetIds && targetIds.length ? new Set(targetIds) : null
  const candidates = all.filter((n: any) => {
    if (n.data?.nodeType !== 'Text') return false
    if (allowed && !allowed.has(n.id)) return false
    const inputs: any[] = n.data?.inputs || []
    const srcIdx = inputs.findIndex(i => i.name === 'source')
    if (srcIdx < 0) return false
    const wired = inputs[srcIdx]?.link != null
      || edges.some(e => e.target === n.id && e.targetHandle === `input-${srcIdx}`)
    if (!wired) return false
    const entries: string[] = n.data?.properties?.textEntries
      || [n.data?.widgetsValues?.[0] ?? '']
    return entries.some(s => !(s ?? '').trim())
  })
  if (candidates.length === 0) return false

  // Multiple candidates: pick the one with the most empty slots. Predictable
  // and matches user intent ("the node I just added a bunch of empty rows to").
  const target = candidates.reduce((best: any, n: any) => {
    const empties = (n.data?.properties?.textEntries || []).filter((s: string) => !(s ?? '').trim()).length || 1
    const bestEmpties = best ? ((best.data?.properties?.textEntries || []).filter((s: string) => !(s ?? '').trim()).length || 1) : 0
    return empties > bestEmpties ? n : best
  }, null as any)

  const widgetDefs: any[] = target.data?.widgetDefs || []
  const textIdx = widgetDefs.findIndex((w: any) => w?.name === 'text')
  if (textIdx < 0) return false
  if (!Array.isArray(target.data.widgetsValues)) target.data.widgetsValues = []
  if (!target.data.properties) target.data.properties = {}
  if (!Array.isArray(target.data.properties.textEntries)) {
    // Seed entries from the legacy widget value so we always have an array
    // to write into. Single-slot nodes still get auto-fill — the LLM result
    // lands in entries[0], persisting what previously was an ephemeral
    // data.text echo.
    target.data.properties.textEntries = [target.data.widgetsValues[textIdx] ?? '']
  }
  const entries: string[] = target.data.properties.textEntries
  const emptySlots: number[] = []
  for (let i = 0; i < entries.length; i++) {
    if (!(entries[i] ?? '').trim()) emptySlots.push(i)
  }
  if (emptySlots.length === 0) return false

  textAutofillRunning = true
  const origWidget = target.data.widgetsValues[textIdx]
  // Clear the widget so the backend's `text if text else source` falls
  // through to the upstream value for every iteration.
  target.data.widgetsValues[textIdx] = ''

  try {
    for (let iter = 0; iter < emptySlots.length; iter++) {
      const slotIdx = emptySlots[iter]!
      // Reset the prior result so we can detect the new one — without this
      // a failed iteration would silently inherit the previous text.
      delete target.data.text
      const completed = awaitExecutionComplete()
      const queued = await runVueWorkflow(targetIds, {
        ...opts,
        ...(iter === 0
          ? { costConfirmIterations: emptySlots.length }
          : { skipCostConfirm: true }),
      })
      if (queued === false) {
        completed.catch(() => {}) // listener self-cleans on its own timeout
        break
      }
      try {
        await completed
      } catch (err) {
        console.warn('[Text autofill] await execution_complete failed:', err)
        break
      }
      // Tiny grace period: the bridge's `executed` event for the Text node
      // and the `execution_complete` are not guaranteed to arrive in order,
      // so give the data.text writer a moment to land.
      await new Promise(r => setTimeout(r, 80))
      const result = target.data.text
      if (typeof result !== 'string' || result.length === 0) {
        await new Promise(r => setTimeout(r, 150))
        continue
      }
      // Multi-line shortcut: if the upstream returned a list of items
      // (Brainstorm-style: one per line) AND we still have multiple empty
      // slots to fill, distribute the lines across them in one shot
      // instead of looping. Saves N-1 LLM calls and is what the user
      // almost certainly intended when wiring a list-returning node into
      // an N-slot Text node.
      const lines = result.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      const remaining = emptySlots.slice(iter)
      if (lines.length >= 2 && remaining.length >= 2) {
        for (let k = 0; k < remaining.length && k < lines.length; k++) {
          entries[remaining[k]!] = lines[k]!
        }
        break
      }
      // Single-value result — assign and continue iterating.
      // Mutate via array index so Vue's reactivity picks it up.
      entries[slotIdx] = result
      // Pause briefly so the bridge / queue settles between submissions.
      await new Promise(r => setTimeout(r, 150))
    }
  } finally {
    target.data.widgetsValues[textIdx] = origWidget
    delete target.data.text
    textAutofillRunning = false
  }
  return true
}

// Text-iterator run: a Text artifact node holds N entries; we want to run
// the workflow once per entry, swapping the node's widget value before each
// queue submission. We can't just dispatch N runFiltered events back-to-back
// because runVueWorkflow reads the live canvas state every time — so we
// mutate the canvas node's widget value, await the run, then move on.
let textIteratorRunning = false
async function handleRunTextIterator(e: Event) {
  if (textIteratorRunning) {
    console.warn('[Iterator] already running, ignoring re-entry')
    return
  }
  const detail = (e as CustomEvent).detail as { nodeId?: string; entries?: string[] } | undefined
  const nodeId = detail?.nodeId
  const entries = (detail?.entries || []).filter(s => typeof s === 'string')
  if (!nodeId || entries.length === 0) return
  const canvas = vueCanvasRef.value
  if (!canvas?.getNodes) return

  const all = canvas.getNodes() as any[]
  const node = all.find(n => n.id === nodeId)
  if (!node) {
    console.warn('[Iterator] node not found:', nodeId)
    return
  }

  // Resolve the position of the `text` widget in this node's widget defs.
  // We mutate widgetsValues[idx] before each run so the workflow snapshot
  // picks up the iteration's entry value.
  const widgetDefs: any[] = node.data?.widgetDefs || []
  const textIdx = widgetDefs.findIndex((w: any) => w?.name === 'text')
  if (textIdx < 0) {
    console.warn('[Iterator] no `text` widget on node', nodeId)
    return
  }
  if (!Array.isArray(node.data.widgetsValues)) node.data.widgetsValues = []

  textIteratorRunning = true
  // Stash original so we can restore on completion — otherwise the last
  // entry would stick as the "active" widget value, which is surprising
  // when the user goes back to single-shot Run.
  const original = node.data.widgetsValues[textIdx]
  try {
    for (let i = 0; i < entries.length; i++) {
      node.data.widgetsValues[textIdx] = entries[i]
      // Materialize downstream sinks before queuing — same dance as
      // handleRunFiltered. Iterator only ever runs from this one node.
      const expanded = canvas.materializeAutoImageSinks?.([nodeId]) ?? [nodeId]
      const queued = await runVueWorkflow(expanded, i === 0
        ? { costConfirmIterations: entries.length }
        : { skipCostConfirm: true })
      if (queued === false) break // user declined the cost confirm
      // Small breather so the bridge / queue settles before the next.
      await new Promise(r => setTimeout(r, 250))
    }
  } finally {
    node.data.widgetsValues[textIdx] = original
    textIteratorRunning = false
  }
}

// Variations ×N: re-run the artifact's producing generator N times with fresh
// seeds; each result lands as a Take on the artifact. Sequential like the text
// iterator — runVueWorkflow reads live canvas state (and rolls seeds) per call.
let variationsRunning = false
async function handleRunVariations(e: Event) {
  if (variationsRunning) {
    console.warn('[Variations] already running, ignoring re-entry')
    return
  }
  const detail = (e as CustomEvent).detail as { nodeId?: string; count?: number } | undefined
  const nodeId = detail?.nodeId
  const count = Math.min(Math.max(1, detail?.count ?? 4), 8)
  if (!nodeId) return
  variationsRunning = true
  try {
    for (let i = 0; i < count; i++) {
      const expanded = vueCanvasRef.value?.materializeAutoImageSinks?.([nodeId]) ?? [nodeId]
      const queued = await runVueWorkflow(expanded, i === 0
        ? { rerollScope: 'variation', costConfirmIterations: count }
        : { rerollScope: 'variation', skipCostConfirm: true })
      if (queued === false) break // user declined the cost confirm
      // Small breather so the bridge / queue settles before the next.
      await new Promise(r => setTimeout(r, 250))
    }
  } finally {
    variationsRunning = false
  }
}

// `@` promote button (ArtifactImageNode) → name the currently-displayed image
// and write it into the project's @refs registry. Writes go straight onto
// activeProjectDoc.value.assetRegistry so they ride the existing autosave.
// Also accepts a BATCH form `detail.refs = [{ name, entry }, …]` (moodboard
// save, Plan B Task B5) — several registry writes, one persist, one toast.
function onCreateRef(e: Event) {
  const detail = (e as CustomEvent).detail || {}
  if (!activeProjectDoc.value) return
  const batch: { name: string, entry: { filename: string, text?: string } }[]
    = Array.isArray(detail.refs)
      ? detail.refs.filter((r: any) => r?.name && r?.entry?.filename)
      : (detail.name && detail.entry?.filename ? [{ name: detail.name, entry: detail.entry }] : [])
  if (!batch.length) return
  let reg = activeProjectDoc.value.assetRegistry ?? {}
  for (const r of batch) reg = setRef(reg, r.name, r.entry)
  activeProjectDoc.value.assetRegistry = reg
  markDocEdited()
  persistWorkflows()
  toast.success(batch.length === 1
    ? `Reference @${batch[0]!.name} created`
    : `${batch.length} board references created (@${batch[0]!.name}…)`)
}

onMounted(() => {
  window.addEventListener('sailor:runFiltered', handleRunFiltered)
  window.addEventListener('sailor:runAll', handleRunAll)
  window.addEventListener('sailor:openInspector', handleOpenInspector)
  window.addEventListener('sailor:runTextIterator', handleRunTextIterator)
  window.addEventListener('sailor:runVariations', handleRunVariations)
  window.addEventListener('sailor:reloadCanvas', forceReloadCanvas)
  window.addEventListener('sailor:openActions', handleOpenActions)
  window.addEventListener('sailor:createRef', onCreateRef)
  window.addEventListener('sailor:markReady', handleMarkReady)
  window.addEventListener('sailor:stopRun', handleStopRun)
  runEstimateTimer = setInterval(updateRunEstimate, 2000)
  // Escape hatch: force-reload the embedded ComfyUI canvas from the console
  // (`__reloadCanvas()`) when its node schema goes stale after a backend change.
  ;(window as any).__reloadCanvas = forceReloadCanvas
  startHealthPoll()
})
onBeforeUnmount(() => {
  window.removeEventListener('sailor:runFiltered', handleRunFiltered)
  window.removeEventListener('sailor:runAll', handleRunAll)
  window.removeEventListener('sailor:openInspector', handleOpenInspector)
  window.removeEventListener('sailor:runTextIterator', handleRunTextIterator)
  window.removeEventListener('sailor:runVariations', handleRunVariations)
  window.removeEventListener('sailor:reloadCanvas', forceReloadCanvas)
  window.removeEventListener('sailor:openActions', handleOpenActions)
  window.removeEventListener('sailor:createRef', onCreateRef)
  window.removeEventListener('sailor:markReady', handleMarkReady)
  window.removeEventListener('sailor:stopRun', handleStopRun)
  if (runEstimateTimer) clearInterval(runEstimateTimer)
  stopHealthPoll()
})

// A node asked to stop (the running capsule's coral square). Routed here
// rather than reimplemented on the node, because interrupting is a queue-wide
// operation and this is where the one implementation lives — the toolbar stop
// button calls the same function.
function handleStopRun() {
  stopVueWorkflow()
}

// Stop/interrupt the current ComfyUI execution and clear the queue
async function stopVueWorkflow() {
  try {
    await Promise.all([
      fetch('/interrupt', { method: 'POST' }),
      fetch('/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) }),
    ])
  }
  catch (err) {
    console.error('[VueNodes] Failed to interrupt:', err)
  }
}

// Single shared ComfyUI iframe — all project tabs share one iframe
const WORKFLOWS_STORAGE_KEY = 'sailor:workflows'

// Restore persisted workflows from sessionStorage. Older sessions stored a
// bare workflow per tab — wrap those into one-canvas docs on the way in.
function loadPersistedWorkflows(): Record<string, any> {
  if (import.meta.server) return {}
  try {
    const saved = sessionStorage.getItem(WORKFLOWS_STORAGE_KEY)
    const parsed = saved ? JSON.parse(saved) : {}
    for (const key of Object.keys(parsed)) parsed[key] = toProjectDoc(parsed[key])
    return parsed
  }
  catch { return {} }
}

const savedWorkflows = reactive<Record<string, any>>(loadPersistedWorkflows()) // tabId → ProjectDoc

// tabId → ms of the last USER EDIT made in THIS window. savedAt must track
// content freshness, not serialization time — a stale window re-serializing
// old content must not re-label it as newest (see stampDocForSave). Every
// doc-level mutation site calls markDocEdited; snapshot time only ever copies
// this stamp forward, monotonically.
const docEditedAt: Record<string, number> = {}
function markDocEdited(tabId?: string) {
  const id = tabId ?? activeTab.value?.id
  if (id) docEditedAt[id] = Date.now()
}

// The workflow the Vue canvas should display: the active canvas of the active
// tab's doc. Switching canvases (or restoring a version) swaps this to a new
// object reference, which is what VueNodeCanvas's prop watch keys on.
const activeTabWorkflow = computed(() => {
  const doc = savedWorkflows[activeTab.value.id]
  if (!doc) return undefined
  return isProjectDoc(doc) ? activeCanvasOf(doc).workflow : doc
})

// Persistence failures used to be swallowed silently — a full sessionStorage
// quota froze autosave with zero signal while the card thumbnails kept
// updating, so the user only found out after losing work to a reload.
// Surface failures, throttled: the 3 s debounce would otherwise re-toast on
// every keystroke burst.
const AUTOSAVE_TOAST_THROTTLE_MS = 60_000
let lastAutosaveToastAt = 0
function warnAutosaveFailure(description: string, err?: unknown) {
  if (err !== undefined) console.error('[Sailor] autosave persistence failed:', err)
  const now = Date.now()
  if (now - lastAutosaveToastAt < AUTOSAVE_TOAST_THROTTLE_MS) return
  lastAutosaveToastAt = now
  toast.error('Autosave isn’t saving', { description })
}
const SESSION_SAVE_FAILED_MSG = 'Browser storage write failed (possibly full). Your latest changes may not survive a reload.'

function persistWorkflows() {
  if (import.meta.server) return
  try {
    sessionStorage.setItem(WORKFLOWS_STORAGE_KEY, JSON.stringify(savedWorkflows))
  }
  catch (err) { warnAutosaveFailure(SESSION_SAVE_FAILED_MSG, err) }
}

// Phase 0 (3a): mirror the session snapshot into a durable server-side Project
// version, IN ADDITION to sessionStorage. Strictly additive and best-effort —
// useProjects swallows all errors, and we never await it in a save path, so this
// can't affect the existing (sync) sessionStorage persistence or block a tab
// switch. Uses a single rolling "current" version id per project, so repeated
// saves update in place instead of piling up versions. The body is the whole
// ProjectDoc (every canvas) — the backend treats it as opaque JSON.
// Stale-save rejections (409) get their own throttled toast, separate from the
// generic autosave-failure one: the remedy is different (reload this window,
// not "free up storage"), and sharing warnAutosaveFailure's throttle stamp
// could let one warning mask the other.
let lastStaleSaveToastAt = 0
function warnStaleSaveRejected() {
  const now = Date.now()
  if (now - lastStaleSaveToastAt < AUTOSAVE_TOAST_THROTTLE_MS) return
  lastStaleSaveToastAt = now
  toast.warning('Didn’t save — a newer version exists', {
    description: 'Another window saved this project more recently. Reload this window to continue from the latest version.',
  })
}

// ── One editing window per project (leader election) ───────────────────────
// Exactly one window may edit/save a given project at a time; other windows
// showing it are read-only mirrors (ProjectFollowerOverlay in the template)
// that refresh as the leader saves. Wiring, all in this file:
//   claim    → loadWorkflowForTab (a tab finishing its load claims its uuid)
//   gate     → saveDurableVersionAsync refuses to write unless leader
//   notify   → saveDurableVersionAsync broadcasts each successful save
//   flush    → onFlushRequested (takeover: old leader saves before demoting)
//   refresh  → onRemoteSaved (debounced) + the promotion watcher below
//   release  → closeProjectTab (last tab for a uuid releases leadership)
const leadership = useProjectLeadership()

// Stamp doc-derived preview images (studio bakes, Frame composites — see
// ~/lib/projectCover) onto the project's cover so All Projects can show
// content for projects that never ran a paid render. Candidates are
// HEAD-verified (old docs can reference pruned input files) and an EMPTY
// result is stamped too — deleting every studio/Frame node must clear the
// stale cover, not preserve it. Deduped per uuid so the 3 s debounced
// autosave doesn't re-PUT an unchanged value every burst; cover-only PUTs
// don't bump updatedAt server-side, so stamping never reorders the grid.
const lastSentCoverByProject = new globalThis.Map<string, string>()
const coverStampSeq = new globalThis.Map<string, number>()
async function stampProjectCover(uuid: string, doc: any) {
  // Newest call wins: if another save for this uuid started while our HEAD
  // checks were in flight, drop this (older) stamp instead of racing its PUT.
  const seq = (coverStampSeq.get(uuid) ?? 0) + 1
  coverStampSeq.set(uuid, seq)
  const cover = await filterToExistingImages(extractCoverImages(doc))
  if (coverStampSeq.get(uuid) !== seq) return
  const key = JSON.stringify(cover)
  if (lastSentCoverByProject.get(uuid) === key) return
  lastSentCoverByProject.set(uuid, key)
  void useProjects().setProjectCover(uuid, cover)
}

function saveDurableVersion(tab: any, doc: any) {
  // Fire-and-forget wrapper — the save paths that must await the network
  // round-trip (takeover flush) call saveDurableVersionAsync directly.
  void saveDurableVersionAsync(tab, doc)
}

async function saveDurableVersionAsync(tab: any, doc: any): Promise<void> {
  if (!tab?.projectUuid || !docHasContent(doc)) return
  // Leadership gate — follower windows never write the durable copy. This
  // single gate covers tab-switch saves, the 3s dirty autosave, beforeunload
  // and closeProjectTab. NOTE: a takeover flush runs while this window is
  // STILL leader, so the gate never blocks the handoff save.
  if (!leadership.isLeader(tab.projectUuid)) {
    console.debug('[leader] skipped durable save (follower window):', tab.projectUuid)
    return
  }
  const name = tab.label || 'Untitled project'
  // saveVersion never throws — 'stale' means the backend refused to let this
  // window overwrite a newer copy; null means the save failed outright.
  const id = await useProjects().saveVersion(tab.projectUuid, { id: 'current', name, workflow: doc }, name)
  if (id === 'stale') warnStaleSaveRejected()
  else if (!id) warnAutosaveFailure('The durable server copy of this project isn’t updating.')
  else {
    leadership.notifySaved(tab.projectUuid, (doc as any)?.savedAt)
    void stampProjectCover(tab.projectUuid, doc)
  }
}

// Takeover flush: another window asked to become leader. We are STILL the
// leader here — snapshot the live canvas (only the active tab has unsaved
// on-screen state) and AWAIT the durable save so the handoff is loss-proof.
// The engine caps a hung flush at ~1.5s on the requester side.
leadership.onFlushRequested(async (uuid: string) => {
  const active = activeTab.value
  if (active?.type === 'project' && active.projectUuid === uuid) {
    snapshotActiveCanvasIntoDoc(active.id)
  }
  const tab = tabs.value.find((t: any) => t.type === 'project' && t.projectUuid === uuid)
  const doc = tab ? savedWorkflows[tab.id] : null
  if (tab && doc && docHasContent(doc)) {
    await saveDurableVersionAsync(tab, doc)
  }
})

// Refetch the durable copy and replace this window's session doc outright.
// Follower windows hold no local edits by construction (saves are gated,
// onCanvasDirty short-circuits), so replacing is correct — and we deliberately
// do NOT markDocEdited or re-stamp: the fetched doc keeps its own savedAt.
async function refreshDocFromDurable(uuid: string) {
  const tab = tabs.value.find((t: any) => t.type === 'project' && t.projectUuid === uuid)
  if (!tab) return
  const loaded = await useProjects().loadProject(uuid)
  const body = loaded?.currentVersion?.workflow || null
  if (!docHasContent(body)) return
  savedWorkflows[tab.id] = toProjectDoc(body)
  persistWorkflows()
}

// Follower live mirror: the leader broadcast a save — debounce (per uuid) and
// refetch, so this window tracks the leader without hammering the API during
// keystroke-burst autosaves.
const REMOTE_REFRESH_DEBOUNCE_MS = 1500
const remoteRefreshTimers: Record<string, ReturnType<typeof setTimeout>> = {}
leadership.onRemoteSaved((uuid: string) => {
  if (leadership.isLeader(uuid)) return
  if (!tabs.value.some((t: any) => t.type === 'project' && t.projectUuid === uuid)) return
  if (remoteRefreshTimers[uuid]) clearTimeout(remoteRefreshTimers[uuid])
  remoteRefreshTimers[uuid] = setTimeout(() => {
    delete remoteRefreshTimers[uuid]
    if (leadership.isLeader(uuid)) return // promoted meanwhile — watcher below refreshed
    refreshDocFromDurable(uuid)
  }, REMOTE_REFRESH_DEBOUNCE_MS)
})

// Promotion refresh: follower → leader (takeover completed, or a dead leader's
// pings stopped and we won re-election). Refresh once, immediately, so the new
// leader starts editing from the flushed latest state; the follower overlay
// disappears on its own via role reactivity.
watch(() => ({ ...leadership.roles }), (now, prev) => {
  for (const [uuid, role] of Object.entries(now)) {
    if (role === 'leader' && prev?.[uuid] === 'follower') {
      if (remoteRefreshTimers[uuid]) {
        clearTimeout(remoteRefreshTimers[uuid])
        delete remoteRefreshTimers[uuid]
      }
      refreshDocFromDurable(uuid)
    }
  }
})

// Snapshot the live canvas into its slot in the tab's doc. The single choke
// point for "what's on screen → what's saved":
//   - reroll:false so serializing never mutates live seed widgets (a re-roll
//     would re-trip live-run watchers);
//   - refuses to write while the canvas is still applying a workflow prop —
//     getWorkflow() would return the PREVIOUS canvas and clobber this slot;
//   - refuses to write while this tab's workflow hasn't finished loading
//     (currentProjectTabId lags until loadWorkflowForTab completes) — the
//     canvas is still showing the PREVIOUS tab's graph, and serializing it
//     here is exactly how a fresh "New Project" ended up with a duplicate
//     of the old project's graph;
//   - refuses empty snapshots (canvas mid-unmount), matching the old guard.
// The workflow write goes through toRaw so saving the ACTIVE canvas doesn't
// swap the :workflow prop reference and trigger a pointless graph rebuild.
// Returns the (normalized) doc, or null if the tab has no doc and nothing to
// save (so a not-yet-loaded tab keeps its durable-load path on revisit).
function snapshotActiveCanvasIntoDoc(tabId: string): ProjectDoc | null {
  const canvas = vueCanvasRef.value
  const settled = canvas?.getWorkflow && !canvas.isApplyingWorkflow?.() && currentProjectTabId === tabId
  const snapshot = settled ? canvas.getWorkflow({ reroll: false }) : null
  if (snapshot) snapshot.extra = { ...(snapshot.extra || {}) }
  const hasSnapshot = !!snapshot && (snapshot.nodes?.length ?? 0) > 0
  if (!savedWorkflows[tabId] && !hasSnapshot) return null
  const doc = toProjectDoc(savedWorkflows[tabId])
  savedWorkflows[tabId] = doc
  if (hasSnapshot) {
    const raw = toRaw(doc)
    activeCanvasOf(raw).workflow = snapshot
  }
  // Recency stamp — loadWorkflowForTab compares it against the durable copy's
  // stamp so a stale store can't shadow a fresher one. Stamped from the last
  // EDIT in this window (monotonic, never Date.now() at serialization time),
  // so a stale window can't launder old content as newest. Runs outside the
  // hasSnapshot branch: doc-only mutations (refs, deliverables, brand kit)
  // deserve the stamp even when the canvas snapshot was refused/empty.
  stampDocForSave(toRaw(doc), docEditedAt[tabId])
  return doc
}

// Closing a tab must never destroy work: flush the live canvas into the doc
// (only the ACTIVE tab has unsaved on-screen state), mirror it to the durable
// server-side project version, and only then drop the session copy. The
// project stays restorable from All Projects / Recent — closing ≠ deleting.
function closeProjectTab(tab: any) {
  if (tab.id === activeTab.value?.id) snapshotActiveCanvasIntoDoc(tab.id)
  const doc = savedWorkflows[tab.id]
  if (doc && docHasContent(doc)) saveDurableVersion(tab, doc)
  delete savedWorkflows[tab.id]
  persistWorkflows()
  // Release editing leadership when the LAST open tab for this project goes —
  // a follower window can then promote without waiting out the ping timeout.
  if (tab.projectUuid && !tabs.value.some((t: any) => t.id !== tab.id && t.projectUuid === tab.projectUuid)) {
    leadership.release(tab.projectUuid)
  }
  closeTab(tab.id)
}

// Restore a saved version (from the project menu) onto the canvas. The body
// may be a whole ProjectDoc (new versions) or a bare workflow (old ones) —
// either way it replaces the tab's entire doc. Assigning a fresh object into
// reactive savedWorkflows swaps the canvas's :workflow prop reference, which
// triggers VueNodeCanvas's prop watch to rebuild the graph. The restored state
// becomes the working state and autosaves to the rolling 'current' on the
// next switch/unload.
function onRestoreVersion(body: any) {
  const tab = activeTab.value
  if (!tab || !docHasContent(body)) return
  const doc = toProjectDoc(body)
  doc.savedAt = Date.now() // an explicit restore becomes the newest state
  markDocEdited(tab.id) // keep docEditedAt coherent with the explicit stamp
  savedWorkflows[tab.id] = doc
  persistWorkflows()
  if (!vueNodesEnabled.value) {
    sendLoadWorkflow(JSON.parse(JSON.stringify(activeCanvasOf(savedWorkflows[tab.id]).workflow)))
  }
}

// ── Multi-canvas operations (project menu) ──────────────────────────────────
// The active tab's doc, for the project menu's canvas list. Normalized lazily:
// a tab that hasn't loaded yet has no doc and the menu shows nothing to switch.
const activeProjectDoc = computed<ProjectDoc | null>(() => {
  if (activeTab.value.type !== 'project') return null
  const doc = savedWorkflows[activeTab.value.id]
  return isProjectDoc(doc) ? doc : null
})

// Read-only registry for descendant node components (Tasks 8 & 9 inject this).
provide('assetRegistry', computed<RefRegistry>(() => activeProjectDoc.value?.assetRegistry ?? {}))
// Whole-doc read access for children that scope UI to "this project" (e.g. the
// Timeline editor's Project media tab walks every canvas for referenced files).
provide('projectDoc', activeProjectDoc)
// Persist callback for the Deliverables page (mirrors the durable-version save
// other project-doc mutators use below).
function persistDeliverablesDoc() {
  markDocEdited() // deliverables mutations change persisted doc content
  persistWorkflows()
  const t = activeTab.value
  if (t.type === 'project' && activeProjectDoc.value) saveDurableVersion(t, activeProjectDoc.value)
}
provide('persistDeliverables', persistDeliverablesDoc)

// "Mark ready" (node context menu) → append the node's rendered output to the
// project's deliverables (curation shelf). Same persist body as the
// Deliverables page above, so both paths stay in sync.
const deliverablesApi = useDeliverables(activeProjectDoc, persistDeliverablesDoc)

// Node ids whose output is currently marked ready → drives the on-canvas ready
// indicator (NodeReadyBadge), injected by every artifact node component.
const readyNodeIds = computed(() => {
  const s = new Set<string>()
  for (const it of (activeProjectDoc.value?.deliverables ?? [])) {
    if (it.kind === 'single') { if (it.ref.sourceNodeId != null) s.add(String(it.ref.sourceNodeId)) }
    else for (const r of it.items) if (r.sourceNodeId != null) s.add(String(r.sourceNodeId))
  }
  return s
})
provide('readyNodeIds', readyNodeIds)

function resolveOutputRef(nodeId: string, output: any): import('~/lib/deliverables/model').ArtifactRef | null {
  if (!output?.filename) return null
  const f = String(output.filename)
  const media = /\.(mp4|webm|mov|mkv|m4v)$/i.test(f) ? 'video'
    : /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(f) ? 'audio' : 'image'
  // Preserve the node's actual /view serve type — 'temp' (live-preview / result
  // unique frames captured as takes) and 'input' must survive, or the tile 404s.
  const viewType = (output.type === 'input' || output.type === 'temp') ? output.type : 'output'
  return { filename: f, subfolder: output.subfolder || '', media, viewType, sourceNodeId: nodeId }
}

function handleMarkReady(e: Event) {
  const { nodeId, output } = (e as CustomEvent).detail ?? {}
  if (nodeId == null) return
  const ref = resolveOutputRef(String(nodeId), output)
  if (!ref) { toast.error('No output to mark ready yet — run this node first'); return }
  const added = deliverablesApi.markReady(ref, ref.filename)
  toast[added ? 'success' : 'info'](added ? 'Marked ready' : 'Already in deliverables')
}

// Re-entrancy guard: a switch serializes the outgoing canvas, swaps the doc's
// active id, and (in LiteGraph mode) pushes the target into the iframe. Block
// further switches until that completes so two rapid clicks can't interleave.
const canvasSwitching = ref(false)

// Project view mode: 'canvas' shows the node graph, 'deliverables' shows the
// pinned "Ready to deliver" page over it (see ProjectMenu's pinned entry).
const projectView = ref<'canvas' | 'deliverables'>('canvas')
function showDeliverables() { projectView.value = 'deliverables' }
function onOpenDeliverableInCanvas(nodeId: string) {
  projectView.value = 'canvas'
  // Best-effort focus; reuse existing node-focus if present, else no-op.
  window.dispatchEvent(new CustomEvent('sailor:focusNode', { detail: { nodeId } }))
}

async function switchProjectCanvas(canvasId: string) {
  projectView.value = 'canvas'
  const tab = activeTab.value
  if (tab.type !== 'project' || canvasSwitching.value) return
  const doc = toProjectDoc(savedWorkflows[tab.id])
  savedWorkflows[tab.id] = doc
  if (doc.activeCanvasId === canvasId) return
  const target = doc.canvases.find((c) => c.id === canvasId)
  if (!target) return
  canvasSwitching.value = true
  try {
    if (vueNodesEnabled.value) {
      // Serialize the outgoing canvas first (guarded against mid-load/empty
      // snapshots), then swap the active id — the activeTabWorkflow computed
      // changes reference and the canvas prop watch rebuilds the graph.
      snapshotActiveCanvasIntoDoc(tab.id)
      doc.activeCanvasId = canvasId
    }
    else {
      const workflow = await getWorkflowFromIframe()
      if (workflow && (workflow.nodes?.length ?? 0) > 0) {
        activeCanvasOf(doc).workflow = workflow
      }
      doc.activeCanvasId = canvasId
      await sendLoadWorkflow(JSON.parse(JSON.stringify(target.workflow || BLANK_WORKFLOW)))
    }
    markDocEdited(tab.id) // the switch itself changes persisted doc content
    persistWorkflows()
    saveDurableVersion(tab, doc)
  } finally {
    canvasSwitching.value = false
  }
}

async function addProjectCanvas() {
  const tab = activeTab.value
  if (tab.type !== 'project' || canvasSwitching.value) return
  const doc = toProjectDoc(savedWorkflows[tab.id])
  savedWorkflows[tab.id] = doc
  const canvas: ProjectCanvas = { id: makeCanvasId(), name: nextCanvasName(doc), workflow: makeBlankWorkflow() }
  doc.canvases.push(canvas)
  markDocEdited(tab.id)
  await switchProjectCanvas(canvas.id)
}

function renameProjectCanvas(canvasId: string, name: string) {
  const doc = activeProjectDoc.value
  const canvas = doc?.canvases.find((c) => c.id === canvasId)
  if (!canvas || !name.trim()) return
  canvas.name = name.trim()
  markDocEdited()
  persistWorkflows()
}

async function deleteProjectCanvas(canvasId: string) {
  const tab = activeTab.value
  const doc = activeProjectDoc.value
  if (!doc || doc.canvases.length <= 1 || canvasSwitching.value) return
  const idx = doc.canvases.findIndex((c) => c.id === canvasId)
  if (idx === -1) return
  // Deleting the canvas on screen: move to a neighbor first so the doc never
  // points at a canvas that no longer exists.
  if (doc.activeCanvasId === canvasId) {
    const neighbor = doc.canvases[idx + 1] ?? doc.canvases[idx - 1]
    if (!neighbor) return
    await switchProjectCanvas(neighbor.id)
  }
  const at = doc.canvases.findIndex((c) => c.id === canvasId)
  if (at !== -1) doc.canvases.splice(at, 1)
  markDocEdited(tab.id)
  persistWorkflows()
  saveDurableVersion(tab, doc)
}

// ── Brand kit (project menu) ────────────────────────────────────────────────
// The doc owns brandKitId; the library composable resolves it to a kit entry.
// Setting flows through the same doc-mutation + persistence path as the other
// canvas edits (mutate the reactive doc, persistWorkflows, durable mirror).
const brandLib = useBrandLibrary(computed(() => activeProjectDoc.value?.brandKitId))
const brandKitName = computed(() => brandLib.activeEntry.value?.name ?? null)
const brandSwatches = computed(() =>
  kitSwatches(brandLib.activeEntry.value?.kit).slice(0, 3).map(s => s.hex))
function setBrandKit(id: string | null) {
  const tab = activeTab.value
  if (tab.type !== 'project') return
  const doc = toProjectDoc(savedWorkflows[tab.id])
  savedWorkflows[tab.id] = doc
  doc.brandKitId = id
  markDocEdited(tab.id)
  persistWorkflows()
  saveDurableVersion(tab, doc)
}

// Descendants (e.g. the Smart Layout editor modal in the canvas) read the
// project's active kit through this — same merge inputs everywhere.
provide('sailor:brand', {
  activeKit: brandLib.activeKit,
  activeKitId: computed(() => activeProjectDoc.value?.brandKitId ?? null),
  setBrandKit,
})

// Rename the project from the menu: tab label + recent-projects name +
// durable project record, mirroring what the tab double-click rename does.
function renameActiveProject(name: string) {
  const tab = activeTab.value
  if (tab.type !== 'project' || !name.trim()) return
  renameTab(tab.id, name)
  if (tab.workflowId) useRecentProjects().setProjectName(tab.workflowId, name.trim())
  if (tab.projectUuid) useProjects().renameProject(tab.projectUuid, name.trim())
}

// The full doc with the live canvas serialized in, deep-copied — what a named
// version snapshot should contain. Async because the LiteGraph path has to
// round-trip through the iframe.
async function getProjectDocForVersionSave(): Promise<any | null> {
  const tab = activeTab.value
  if (tab.type !== 'project') return null
  if (vueNodesEnabled.value) {
    const doc = snapshotActiveCanvasIntoDoc(tab.id)
    return doc ? JSON.parse(JSON.stringify(toRaw(doc))) : null
  }
  const doc = toProjectDoc(savedWorkflows[tab.id])
  savedWorkflows[tab.id] = doc
  const workflow = await getWorkflowFromIframe()
  if (workflow && (workflow.nodes?.length ?? 0) > 0) {
    activeCanvasOf(doc).workflow = workflow
  }
  return JSON.parse(JSON.stringify(toRaw(doc)))
}

// Autosave: snapshot current canvas and persist to sessionStorage.
// Only called on specific events (beforeunload, tab switch) — never on a timer.
function autosaveCurrentWorkflow() {
  const tab = activeTab.value
  if (tab?.type !== 'project') return
  if (vueNodesEnabled.value && vueCanvasRef.value?.getWorkflow) {
    const doc = snapshotActiveCanvasIntoDoc(tab.id)
    if (doc && docHasContent(doc)) {
      try { sessionStorage.setItem(WORKFLOWS_STORAGE_KEY, JSON.stringify(toRaw(savedWorkflows))) }
      catch (err) { warnAutosaveFailure(SESSION_SAVE_FAILED_MSG, err) }
      saveDurableVersion(tab, doc)
    }
  }
}

// Continuous autosave: the canvas dispatches `sailor:canvasDirty` on every
// nodes/edges mutation (same deep watch as undo-history); we debounce that into
// a full autosave — snapshot → sessionStorage → durable mirror — so a crash,
// killed dev server, or skipped beforeunload loses at most a few seconds of
// work instead of everything since the last tab switch. Runs through
// snapshotActiveCanvasIntoDoc's guards, so mid-load/mid-apply states still
// refuse to clobber, and getWorkflow({reroll:false}) never touches seeds or
// the run-tracking sets.
const AUTOSAVE_DEBOUNCE_MS = 3000
let autosaveDebounceTimer: ReturnType<typeof setTimeout> | null = null
function onCanvasDirty() {
  // Follower windows are read-only mirrors: the overlay swallows pointer
  // events, but stray keyboard-driven canvas mutations could still land here.
  // Don't even schedule the autosave (saves are leader-gated anyway).
  const t = activeTab.value
  if (t?.type === 'project' && t.projectUuid && leadership.roleOf(t.projectUuid) === 'follower') return
  // Record the edit NOW (not after the debounce): canvasDirty only fires for
  // real canvas mutations of the active tab (suppressed while a workflow is
  // being applied), so this is the canonical "user touched the canvas" signal.
  markDocEdited()
  if (autosaveDebounceTimer) clearTimeout(autosaveDebounceTimer)
  autosaveDebounceTimer = setTimeout(() => {
    autosaveDebounceTimer = null
    autosaveCurrentWorkflow()
  }, AUTOSAVE_DEBOUNCE_MS)
}

// Prompts queued by live-run should not surface "started" / "completed" toasts
// or the canvas status bar — slider drags would flicker that surface dozens of
// times a second. The bridge synthesizes execution_complete without a prompt_id,
// so we can't match by id. ComfyUI executes one prompt at a time, so we track
// a single flag set at execution_start and consumed at execution_complete/error.
// (Ref rather than `let` so the status bar's `running` prop can react.)
const pendingLiveRuns = ref(0)
const currentRunSilent = ref(false)
let pendingLiveRunsResetTimer: ReturnType<typeof setTimeout> | null = null

// No-response watchdog for the queuePrompt handshake. We postMessage
// `queuePrompt` to the bridge iframe and return immediately — but if the
// iframe's LiteGraph registry is stale after a ComfyUI restart (it silently
// drops nodes / no-ops the queue) or the message lands on a half-loaded frame,
// the run fails with ZERO feedback: no /prompt POST, status stuck Idle, no
// toast. The bridge posts a terminal event for every outcome it reaches
// (`queued` on success, `queue_error` on any failure) — so silence past the
// timeout means the handler never ran. Surface it instead of hanging.
const QUEUE_WATCHDOG_MS = 8000
let queueWatchdogTimer: ReturnType<typeof setTimeout> | null = null
function clearQueueWatchdog() {
  if (queueWatchdogTimer) { clearTimeout(queueWatchdogTimer); queueWatchdogTimer = null }
}

// Per-run STALL watchdogs for DIRECT-mode runs, keyed by prompt_id. In direct
// mode the resolved /prompt POST IS the server's acknowledgment (queue()
// awaits it), so there is no separate handshake to time out — a slow model is
// NOT a failure. What we guard against instead is a live run that goes SILENT:
// the server stops emitting any WS event for it (worker died mid-render, socket
// wedged) and the run would otherwise hang 'running' forever.
//
// So this is a generous NO-EVENT stall timer, not an 8s handshake timer: armed
// at registerRun and RE-ARMED every time handleBridgeEvent sees ANY event
// carrying that prompt_id (via rearmDirectRunWatchdog). It only fires if
// DIRECT_RUN_STALL_MS elapse with total silence for a still-live run; cleared on
// terminal completion events as before. (This fixes the false "didn't start"
// fires when Re-roll ×N queues prompts serially behind each other on a worker —
// the 2nd prompt's first event legitimately arrives only after the 1st, which a
// short per-run timer misread as a stall.) The bridge path keeps armQueueWatchdog.
// NB: `Map` here would resolve to the lucide-vue-next icon imported above,
// not the global constructor — use globalThis.Map explicitly.
const DIRECT_RUN_STALL_MS = 120_000
const directRunWatchdogs = new globalThis.Map<string, ReturnType<typeof setTimeout>>()
// prompt_id → its originating tab, so a re-arm (which only carries the id) can
// still idle the right tab if the run ultimately stalls.
const directRunWatchdogTabs = new globalThis.Map<string, string>()
function clearDirectRunWatchdog(promptId: string) {
  const t = directRunWatchdogs.get(promptId)
  if (t) { clearTimeout(t); directRunWatchdogs.delete(promptId) }
  directRunWatchdogTabs.delete(promptId)
}
function armDirectRunWatchdog(promptId: string, tabId: string) {
  directRunWatchdogTabs.set(promptId, tabId)
  const existing = directRunWatchdogs.get(promptId)
  if (existing) clearTimeout(existing)
  directRunWatchdogs.set(promptId, setTimeout(() => {
    directRunWatchdogs.delete(promptId)
    directRunWatchdogTabs.delete(promptId)
    console.error('[Run] no WS event for direct prompt in %dms — run stalled', DIRECT_RUN_STALL_MS)
    toast.error('Run stalled — no response from the server')
    finishRun(promptId, 'error')
    if (tabId && inFlight({ tabId }).length === 0) updateTabStatus(tabId, 'idle')
    // A stalled run's node would shimmer forever (no completion event will
    // ever clear it) — once NOTHING is in flight anywhere, sweep run visuals.
    if (inFlight().length === 0) vueCanvasRef.value?.clearAllRunVisuals?.()
  }, DIRECT_RUN_STALL_MS))
}
// Re-arm the stall timer on any event carrying this prompt_id, IF a watchdog is
// still live for it (i.e. it hasn't been cleared by a completion event). Reuses
// the originating tab captured at arm time. No-op for bridge-path prompt_ids.
function rearmDirectRunWatchdog(promptId: string) {
  if (!directRunWatchdogs.has(promptId)) return
  const tabId = directRunWatchdogTabs.get(promptId) ?? ''
  armDirectRunWatchdog(promptId, tabId)
}
function armQueueWatchdog(tabId: string) {
  clearQueueWatchdog()
  queueWatchdogTimer = setTimeout(() => {
    queueWatchdogTimer = null
    console.error('[Run] no bridge response after queuePrompt — stale canvas or dropped message')
    toast.error('Run didn’t start', {
      description: 'The ComfyUI canvas didn’t respond — it can go stale after a restart. Reload the page and try again.',
    })
    if (tabId) updateTabStatus(tabId, 'idle')
  }, QUEUE_WATCHDOG_MS)
}

function handleLiveRun(e: Event) {
  // Live preview runs are SCOPED to the node that asked for them. targetIds
  // routes through getFilteredWorkflow (upstream keep-set; unchanged upstream
  // cache-hits on the backend). Passing undefined here runs the FULL graph —
  // that made "connect an edge into SmartLayout" re-execute every generator on
  // the canvas, so an id-less event now refuses to run instead of running all.
  const nodeId = (e as CustomEvent).detail?.nodeId
  if (!nodeId) { console.warn('[LiveRun] dropped: no nodeId on sailor:liveRun'); return }
  pendingLiveRuns.value++
  // Safety: drop the counter if no execution_start arrives (e.g. queue rejected the prompt).
  if (pendingLiveRunsResetTimer) clearTimeout(pendingLiveRunsResetTimer)
  pendingLiveRunsResetTimer = setTimeout(() => { pendingLiveRuns.value = 0 }, 10000)
  runVueWorkflow([String(nodeId)], { live: true })
}

onMounted(() => {
  window.addEventListener('beforeunload', autosaveCurrentWorkflow)
  window.addEventListener('sailor:canvasDirty', onCanvasDirty)
  window.addEventListener('sailor:liveRun', handleLiveRun)
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', autosaveCurrentWorkflow)
  window.removeEventListener('sailor:canvasDirty', onCanvasDirty)
  window.removeEventListener('sailor:liveRun', handleLiveRun)
  if (autosaveDebounceTimer) { clearTimeout(autosaveDebounceTimer); autosaveDebounceTimer = null }
})
let sharedIframeReady = false
// True while a workflow is being pushed into the canvas (incl. waiting for the
// bridge to become ready on a cold start). Drives the loading overlay so the
// wait reads as "initializing", not a dead/broken button.
const workflowLoading = ref(false)
let workflowLoadingTimer: ReturnType<typeof setTimeout> | null = null
const vueCanvasRef = ref<any>(null)
let currentProjectTabId: string | null = null // tracks which project tab's workflow is loaded

// Bridge readiness handshake: the bridge posts { status: 'ready' } once ComfyUI's
// app + node defs are fully initialized. We gate workflow loads on this instead of
// a fixed delay, so "new workflow" works the instant the canvas is usable (cold
// starts can take ~a minute) rather than silently dropping early messages.
let bridgeIsReady = false
const bridgeReady = ref(false) // reactive mirror of bridgeIsReady for the template
let bridgeReadyResolve: (() => void) | null = null
let bridgeReadyPromise: Promise<void> = new Promise((r) => { bridgeReadyResolve = r })

function resetBridgeReady() {
  bridgeIsReady = false
  bridgeReady.value = false
  bridgeReadyPromise = new Promise((r) => { bridgeReadyResolve = r })
}

// The embedded ComfyUI canvas (iframe) fetches its node schema ONCE at load.
// After a backend node-schema change it goes stale — it maps widget values to
// the OLD widget order (e.g. a taste_profile value landing in the prompt_strength
// slot → "could not convert string to float" → 400). A plain page refresh in dev
// (HMR) often doesn't remount the iframe, so we force it: reset the bridge-ready
// handshake AND reload the iframe with a cache-bust. Exposed on window so it can
// be triggered from the console; also wired to the "Reload canvas" control.
// Public origin the ComfyUI canvas iframe loads from. In local mode this is the
// operator's own ComfyUI on :8188 (or NUXT_PUBLIC_COMFY_ORIGIN if they moved it).
//
// F3 rider: hosted has NO engine origin, and that is now a property of this
// line rather than of the deployment's env. The engine is reachable only
// through the authed same-origin proxy, where every Stage-5 tenant gate lives —
// a stray NUXT_PUBLIC_COMFY_ORIGIN in a hosted environment would have pointed
// the canvas straight at an ungated engine, and the old `|| 127.0.0.1:8188`
// fallback did it even with the variable unset.
const comfyOrigin = engineOrigin(useRuntimeConfig().public)
const comfyIframeSrc = ref(`${comfyOrigin}/`)
function forceReloadCanvas() {
  resetBridgeReady()
  endWorkflowLoading()
  comfyIframeSrc.value = `${comfyOrigin}/?_cb=${Date.now()}`
}

// Backend boot/ready loader. Polls the backend; on a genuine restart recovery,
// reload the (now-stale) iframe against the fresh backend.
// Guard: while a generation is running, a heavy node can block ComfyUI's event
// loop long enough that the probe times out — a *false* down→up that must NOT
// reload the canvas (that mid-run reload was the cause of the flickering).
// Hosted: probe SAME-ORIGIN. useBackendHealth fetches `${origin}/system_stats`,
// so an empty origin yields the relative `/system_stats` the authed proxy
// serves. The engine origin itself is not reachable from a hosted browser.
const { backendUp, start: startHealthPoll, stop: stopHealthPoll } =
  useBackendHealth(hostedShell ? '' : comfyOrigin, {
    onRecovered: () => forceReloadCanvas(),
    suppressRecovery: () => runningCount.value > 0,
  })

// Truly ready = backend HTTP up AND ComfyUI ready inside the iframe. Hosted has
// no bridge iframe to become ready, so backend-up is the whole condition.
// Tier 1 (bridge retirement): with direct execution the only path, no bridge
// iframe is mounted, so backend-up is the whole readiness condition (same as
// hosted). `bridgeReady` only gates the legacy bridge path, kept for a revert.
const canvasReady = computed(() => backendUp.value && (hostedShell || directExecutionEnabled.value || bridgeReady.value))
const hasBeenReady = ref(false)
watch(canvasReady, (v) => { if (v) hasBeenReady.value = true })

// The status pill is "busy" while the backend/canvas isn't ready OR a workflow
// is loading; the label reflects which.
const backendBusy = computed(() => !canvasReady.value || workflowLoading.value)
const backendLabel = computed(() => {
  if (!backendUp.value) return hasBeenReady.value ? 'Reconnecting to engine…' : 'Starting engine…'
  if (!bridgeReady.value) return 'Loading engine…'
  return 'Loading workflow…'
})

// First open of the heavy Vue canvas (VueNodeCanvas: Vue Flow + many node
// components, plus Vite's first-compile in dev) mounts synchronously and blocks
// the main thread for tens of seconds — during which the browser can't paint, so
// nothing (not even the status pill) appears and the homepage looks frozen.
// Fix: paint an "Opening editor…" overlay FIRST, then defer the canvas mount by
// two animation frames so the overlay is on screen before the stall. Its
// transform-based spinner runs on the compositor thread, so it keeps animating
// even while JS is blocked. `canvasMountAllowed` latches true so later tab
// switches reuse the already-mounted canvas (no re-defer).
const canvasMountAllowed = ref(false)
const canvasOpening = ref(false)
watch(
  () => vueNodesEnabled.value && activeTab.value?.type === 'project',
  (isProject) => {
    // Client-only: the defer/paint is meaningless on the server, and rAF doesn't
    // exist there. canvasMountAllowed stays false during SSR (canvas not rendered),
    // so server and client-initial agree — no hydration mismatch.
    if (!isProject || canvasMountAllowed.value || !import.meta.client) return
    canvasOpening.value = true
    // rAF never fires in hidden/background tabs (cmd-clicked link, session
    // restore, automation), which used to leave "Opening editor…" up forever.
    // Race the rAF fast path against a timeout and visibilitychange→visible;
    // whichever fires first latches the mount exactly once.
    let latched = false
    const onVisible = () => { if (document.visibilityState === 'visible') latch() }
    const fallbackTimer = setTimeout(() => latch(), 1500)
    async function latch() {
      if (latched) return
      latched = true
      clearTimeout(fallbackTimer)
      document.removeEventListener('visibilitychange', onVisible)
      canvasMountAllowed.value = true // mounts VueNodeCanvas (blocks the main thread)
      await nextTick()
      // Overlay clear also needs a non-rAF fallback for hidden tabs.
      requestAnimationFrame(() => { canvasOpening.value = false })
      setTimeout(() => { canvasOpening.value = false }, 300)
    }
    requestAnimationFrame(() => requestAnimationFrame(() => latch()))
    document.addEventListener('visibilitychange', onVisible)
  },
  { immediate: true },
)

// Assign at setup time too (HMR re-runs setup but not always onMounted) so the
// console escape hatch is always present.
if (import.meta.client) (globalThis as any).__reloadCanvas = forceReloadCanvas

// ───────────────────────────────────────────────────────────────────────────
// Parallel-run worker pool (prototype). OFF by default → a single worker,
// identical to today's behavior. Enable in the browser console with:
//   localStorage['sailor:pool'] = 'on'   // uses :8188 + :8189
//   localStorage['sailor:pool'] = 'http://127.0.0.1:8188,http://127.0.0.1:8189'
// then reload. Each project tab is round-robin assigned to a worker; runs on
// different tabs hit different ComfyUI servers and execute concurrently.
// ───────────────────────────────────────────────────────────────────────────
const comfyWorkers = ref<string[]>([comfyOrigin])
// Never hosted: pool workers are extra ComfyUI servers on the operator's own
// machine. A hosted browser has no :8189 to probe (and no engine origin at
// all), so the flag lingering in localStorage would fire a pointless
// cross-origin fetch on every load.
if (import.meta.client && !hostedShell) {
  try {
    const raw = localStorage.getItem('sailor:pool')
    let desired: string[] | null = null
    if (raw === 'on') desired = [comfyOrigin, comfyOrigin.replace(/:\d+/, ':8189')]
    else if (raw) {
      const list = raw.split(',').map(s => s.trim()).filter(Boolean)
      if (list.length > 1) desired = list
    }
    // The pool flag can outlive the extra servers it points at (it lives in
    // localStorage; the :8189 worker is something you start by hand). A dead
    // worker is worse than no worker — every run round-robined onto it waits
    // ~2 minutes for a bridge that never loads, then silently does nothing.
    // So probe each extra worker first and only enable the ones that answer.
    // no-cors because the extra workers are cross-origin without CORS headers:
    // a resolved fetch (even opaque) means a server is listening; a network
    // error means it isn't. Until the probe lands we stay single-worker, which
    // is always safe (worker 0 = the shared iframe).
    if (desired && desired.length > 1) {
      Promise.all(desired.slice(1).map(async (origin) => {
        try {
          await fetch(`${origin}/`, { mode: 'no-cors', signal: AbortSignal.timeout(3000) })
          return origin
        } catch { return null }
      })).then((probed) => {
        const alive = probed.filter((o): o is string => !!o)
        const dead = desired!.slice(1).filter((o) => !alive.includes(o))
        if (dead.length) console.warn('[pool] ignoring unreachable worker(s):', dead.join(', '), '— runs stay on the primary server')
        if (alive.length) comfyWorkers.value = [desired![0], ...alive]
      })
    }
  } catch { /* ignore */ }
}
const poolEnabled = computed(() => comfyWorkers.value.length > 1)

// tabId → worker index (round-robin in assignment order). Worker 0 always = the
// existing shared iframe, so single-worker callers get index 0 unchanged.
const tabWorker = reactive<Record<string, number>>({})
function workerForTab(tabId?: string | null): number {
  if (!poolEnabled.value || !tabId) return 0
  if (tabWorker[tabId] == null) {
    tabWorker[tabId] = Object.keys(tabWorker).length % comfyWorkers.value.length
  }
  return tabWorker[tabId]
}
// worker index → the tab currently running on it (set at submit; a worker runs
// one prompt at a time, so this is enough to route that worker's events back).
const workerRunningTab = reactive<Record<number, string>>({})
// worker index → which doc canvas the in-flight run was queued from. Lets the
// canvas component scope run events/animations to the right canvas — node ids
// collide across a project's canvases, so worker alone isn't enough.
const runningCanvasByWorker = reactive<Record<number, string | null>>({})
// The worker the *currently viewed* canvas runs on — lets the canvas ignore
// other workers' run events (so a background tab's run doesn't clear the active
// tab's animation) and re-apply the right running node when you switch tabs.
const activeWorker = computed(() => workerForTab(activeTab.value?.id))

function getWorkerIframe(idx: number): HTMLIFrameElement | null {
  if (idx === 0) return getSharedIframe()
  return document.querySelector(`iframe[data-worker="${idx}"]`) as HTMLIFrameElement | null
}
function workerIndexOfFrame(win: Window | null): number | null {
  if (!win) return null
  if (getSharedIframe()?.contentWindow === win) return 0
  for (const f of document.querySelectorAll('iframe[data-worker]')) {
    if ((f as HTMLIFrameElement).contentWindow === win) return Number((f as HTMLIFrameElement).dataset.worker)
  }
  return null
}

// Per-worker bridge-ready (the global bridgeIsReady stays for the worker-0 /
// single-worker path; this tracks the extra pool workers).
const workerReady = reactive<Record<number, boolean>>({})
const workerReadyResolvers: Record<number, Array<() => void>> = {}
function markWorkerReady(idx: number) {
  if (workerReady[idx]) return
  workerReady[idx] = true
  ;(workerReadyResolvers[idx] || []).forEach(r => r())
  workerReadyResolvers[idx] = []
}
function waitForWorkerReady(idx: number, timeoutMs = 120000): Promise<void> {
  if (idx === 0) return waitForBridgeReady(timeoutMs) // reuse existing global handshake
  if (workerReady[idx]) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (done) return; done = true; clearInterval(poll); clearTimeout(to); resolve() }
    ;(workerReadyResolvers[idx] ||= []).push(finish)
    const nudge = () => getWorkerIframe(idx)?.contentWindow?.postMessage({ type: 'sailor', action: 'requestStatus' }, '*')
    nudge()
    const poll = setInterval(() => { if (workerReady[idx]) finish(); else nudge() }, 500)
    const to = setTimeout(finish, timeoutMs)
  })
}

function markBridgeReady() {
  if (bridgeIsReady) return
  bridgeIsReady = true
  bridgeReady.value = true
  bridgeReadyResolve?.()
}

// Resolve once the bridge signals ready. Nudges the bridge with requestStatus in
// case our listener attached after it already broadcast (e.g. a frontend-only
// reload while ComfyUI stays loaded). Falls back after timeoutMs so we never hang.
function waitForBridgeReady(timeoutMs = 120000): Promise<void> {
  if (bridgeIsReady) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearInterval(poll)
      clearTimeout(to)
      resolve()
    }
    bridgeReadyPromise.then(finish)
    const nudge = () => {
      getSharedIframe()?.contentWindow?.postMessage({ type: 'sailor', action: 'requestStatus' }, '*')
    }
    nudge()
    const poll = setInterval(() => { if (bridgeIsReady) finish(); else nudge() }, 500)
    const to = setTimeout(finish, timeoutMs)
  })
}

function getSharedIframe(): HTMLIFrameElement | null {
  return document.querySelector('[data-tab-id="comfyui-shared"] iframe') as HTMLIFrameElement | null
}

function beginWorkflowLoading() {
  workflowLoading.value = true
  if (workflowLoadingTimer) clearTimeout(workflowLoadingTimer)
  // Safety net: never let the overlay get stuck if the bridge never confirms.
  workflowLoadingTimer = setTimeout(() => { workflowLoading.value = false }, 125000)
}

function endWorkflowLoading() {
  workflowLoading.value = false
  if (workflowLoadingTimer) { clearTimeout(workflowLoadingTimer); workflowLoadingTimer = null }
}

async function sendLoadWorkflow(workflow: any, workerIdx = 0) {
  // Final-boundary invariant: null any input.link that doesn't resolve to a
  // link in links[]. ComfyUI's graphToPrompt aborts the whole run on the first
  // dangling ref ("No link found in parent graph for id [N] slot [S]"), so we
  // heal here — the last place the workflow is ours before it crosses into the
  // bridge iframe. The warn surfaces the exact node/link when it fires so a
  // recurring source can be traced.
  const healed = healDanglingLinks(workflow)
  if (healed.length) {
    console.warn('[Sailor] healed dangling input link(s) before load:', healed,
      '| has definitions:', !!workflow?.definitions,
      '| nodes:', workflow?.nodes?.length, '| links:', workflow?.links?.length)
  }
  beginWorkflowLoading()
  await waitForWorkerReady(workerIdx)
  const iframe = getWorkerIframe(workerIdx)
  if (iframe?.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'sailor', action: 'loadWorkflow', workflow }, '*')
  }
  else {
    endWorkflowLoading()
  }
  // Otherwise cleared when the bridge confirms via the 'workflow_loaded' event.
}

function getWorkflowFromIframe(): Promise<any> {
  return new Promise((resolve) => {
    const iframe = getSharedIframe()
    if (!iframe?.contentWindow) { resolve(null); return }

    let resolved = false
    const handler = (event: MessageEvent) => {
      if (resolved) return
      if (event.data?.type === 'sailor-bridge' && event.data?.event === 'workflow_data') {
        resolved = true
        window.removeEventListener('message', handler)
        resolve(event.data.workflow)
      }
    }
    window.addEventListener('message', handler)
    iframe.contentWindow.postMessage({ type: 'sailor', action: 'getWorkflow' }, '*')
    // Timeout fallback
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        window.removeEventListener('message', handler)
        resolve(null)
      }
    }, 2000)
  })
}

async function fetchWorkflowFromHistory(promptId: string): Promise<any> {
  try {
    const res = await fetch(`/history/${promptId}`)
    const data = await res.json()
    const entry = data?.[promptId]
    return entry?.prompt?.[3]?.extra_pnginfo?.workflow || null
  }
  catch { return null }
}

async function loadWorkflowForTab(tab: any) {
  if (currentProjectTabId === tab.id && savedWorkflows[tab.id]) return // already loaded

  const saved = savedWorkflows[tab.id]

  if (vueNodesEnabled.value) {
    // Vue mode: store the doc directly (no iframe needed) — the canvas reads
    // its active canvas via the activeTabWorkflow computed.
    if (!saved) {
      // Assign a blank doc SYNCHRONOUSLY, before any await. Until this tab has
      // a doc, activeTabWorkflow is undefined and the canvas keeps rendering
      // the PREVIOUS tab's graph — so a slow fetch below made a fresh "New
      // Project" open as a visual duplicate of the old project (and any
      // snapshot during that window persisted the duplicate durably).
      const placeholder = toProjectDoc(makeBlankWorkflow())
      savedWorkflows[tab.id] = placeholder

      // Phase 0 (3b): if this tab is tied to a durable Project, prefer its saved
      // version — it's the freshest cross-session state (written by 3a on
      // switch/unload), fresher than /history. Strictly a fallback: only runs
      // when there's no in-session sessionStorage snapshot, and degrades to the
      // existing history/blank path if the project or its version is absent.
      // The durable body may be a whole ProjectDoc (new saves) or a bare
      // workflow (old ones) — toProjectDoc normalizes either.
      let body: any = null
      if (tab.projectUuid) {
        const loaded = await useProjects().loadProject(tab.projectUuid)
        body = loaded?.currentVersion?.workflow || null
      }
      if (!docHasContent(body)) {
        if (tab.promptId) {
          body = await fetchWorkflowFromHistory(tab.promptId)
        }
        else if (tab.workflowId) {
          // Try to load from recent workflows API
          try {
            const res = await fetch(`/api/workflows/${tab.workflowId}`)
            const data = await res.json()
            body = data?.workflow || null
          }
          catch { body = null }
        }
      }
      // Swap the real content in only if the placeholder is still what's
      // stored — if something already replaced it (community template,
      // canvas snapshot), that state is newer than what we fetched. toRaw:
      // savedWorkflows is reactive, so reading back yields a proxy.
      if (docHasContent(body) && toRaw(savedWorkflows[tab.id]) === placeholder) {
        savedWorkflows[tab.id] = toProjectDoc(body)
      }
    }
    else if (tab.projectUuid) {
      // Recency guard: sessionStorage survives an in-tab reload but can go
      // silently stale (quota-failed writes, a parallel window) while the
      // durable rolling version kept advancing. Loading the stale copy and
      // letting autosave mirror it back would clobber the fresher durable one
      // — so fetch the durable copy too and keep whichever doc carries the
      // newer savedAt stamp. Identity check mirrors the placeholder guard
      // above: if something replaced the doc while we fetched, that state is
      // newer than either copy and must not be overwritten.
      const before = toRaw(savedWorkflows[tab.id])
      const loaded = await useProjects().loadProject(tab.projectUuid)
      const durableBody = loaded?.currentVersion?.workflow || null
      const durableDoc = durableBody ? toProjectDoc(durableBody) : null
      if (durableDoc && toRaw(savedWorkflows[tab.id]) === before) {
        if (pickNewerDoc(saved, durableDoc).source === 'durable') {
          savedWorkflows[tab.id] = durableDoc
        }
      }
    }
  }
  else {
    // LiteGraph mode: send the doc's active canvas to the iframe
    if (saved) {
      await sendLoadWorkflow(JSON.parse(JSON.stringify(activeCanvasOf(toProjectDoc(saved)).workflow)))
    }
    else if (tab.promptId) {
      const workflow = await fetchWorkflowFromHistory(tab.promptId)
      await sendLoadWorkflow(workflow || BLANK_WORKFLOW)
    }
    else {
      await sendLoadWorkflow(BLANK_WORKFLOW)
    }
  }
  currentProjectTabId = tab.id
  persistWorkflows()
  // Claim editing leadership for this project (resolves to leader/follower in
  // ~400ms; 'claiming' meanwhile shows nothing). Guarded so revisiting an
  // already-led tab doesn't re-run an election.
  if (tab.projectUuid && leadership.roleOf(tab.projectUuid) !== 'leader') {
    leadership.claim(tab.projectUuid)
  }
}

// Handle workflow loaded from community template
function handleLoadTabWorkflow(e: Event) {
  const { tabId, workflow } = (e as CustomEvent).detail
  savedWorkflows[tabId] = toProjectDoc(workflow)
  markDocEdited(tabId) // user loaded fresh content into this tab
  persistWorkflows()
  // This tab now has real content — never treat it as a "fresh blank project"
  // (would otherwise pop the Get Started modal over the loaded workflow).
  seenStartModalTabIds.add(tabId)
  // If this tab is already active, load it now
  const tab = tabs.value.find((t: any) => t.id === tabId)
  if (tab && activeTabId.value === tabId) {
    currentProjectTabId = null // force reload
    loadWorkflowForTab(tab)
  }
}

async function onSharedIframeLoad(event: Event) {
  const iframe = event.target as HTMLIFrameElement
  if (!iframe?.contentWindow) return

  // A fresh iframe load means the bridge will (re)announce readiness.
  resetBridgeReady()
  // Wait for the bridge to signal ComfyUI is actually usable (window.app + node
  // defs loaded) instead of guessing with a fixed delay. Vue mode doesn't drive
  // workflows through the iframe, so it doesn't need to block on this.
  if (!vueNodesEnabled.value) {
    await waitForBridgeReady()
  }
  sharedIframeReady = true

  // Load the workflow for the currently active project tab
  const tab = activeTab.value
  if (tab.type === 'project') {
    await loadWorkflowForTab(tab)
  }
}

// Save/restore workflows when switching between tabs
watch(activeTabId, async (newId, oldId) => {
  const oldTab = tabs.value.find((t) => t.id === oldId)
  const newTab = tabs.value.find((t) => t.id === newId)

  // Save current workflow when leaving a project tab — into the active
  // canvas's slot of the tab's doc. snapshotActiveCanvasIntoDoc guards
  // against empty/mid-load snapshots clobbering a good saved canvas.
  if (oldTab?.type === 'project') {
    if (vueNodesEnabled.value) {
      snapshotActiveCanvasIntoDoc(oldTab.id)
    }
    else if (sharedIframeReady && currentProjectTabId === oldTab.id) {
      // Same guard as the Vue path: if this tab's workflow never finished
      // loading, the iframe still shows the PREVIOUS tab's graph — saving it
      // here would duplicate that graph into this tab's doc.
      const workflow = await getWorkflowFromIframe()
      if (workflow && (workflow.nodes?.length ?? 0) > 0) {
        const doc = toProjectDoc(savedWorkflows[oldTab.id])
        savedWorkflows[oldTab.id] = doc
        activeCanvasOf(doc).workflow = workflow
      }
    }
    persistWorkflows()
    saveDurableVersion(oldTab, savedWorkflows[oldTab.id])
  }

  // Restore workflow when entering a project tab
  if (newTab?.type === 'project') {
    await loadWorkflowForTab(newTab)
  }
})

// When Vue mode is toggled, transfer the workflow between iframe ↔ Vue canvas
watch(vueNodesEnabled, async (enabled) => {
  const tab = activeTab.value
  if (tab.type !== 'project') return

  if (enabled) {
    // ALWAYS fetch fresh — don't trust cache (may be BLANK_WORKFLOW from earlier failure)
    if (tab.promptId) {
      const wf = await fetchWorkflowFromHistory(tab.promptId)
      if (wf) savedWorkflows[tab.id] = toProjectDoc(wf)
    }
    if (!savedWorkflows[tab.id]) {
      savedWorkflows[tab.id] = toProjectDoc(makeBlankWorkflow())
    }
    currentProjectTabId = null
    await loadWorkflowForTab(tab)
  }
})

// ComfyUI sidebar width and tab bar height to crop via CSS
const COMFY_SIDEBAR_W = 0
const COMFY_TABBAR_H = 0

// Status indicator colors
const statusColor = (status?: string) => {
  if (status === 'idle') return '#4ade80'
  if (status === 'running') return 'var(--action)'
  if (status === 'done') return '#4ade80'
  return 'transparent'
}

const queueOpen = ref(false)
const queueData = ref<{ running: any[], pending: any[] }>({ running: [], pending: [] })

// --- Persistent training queue (style/character LoRA + voice) ---------------
// Jobs live server-side (server/plugins/trainingQueue.ts) and survive the
// window closing. The browser is a viewer: we poll /api/training-queue, show
// the jobs in the Queue panel, badge the toolbar, and toast on completion.
interface TrainingJobView {
  id: string
  kind: 'lora' | 'voice'
  status: 'queued' | 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled'
  displayName: string
  loraKind?: 'style' | 'character'
  progressPct: number
  error?: string | null
}
const trainingJobs = ref<TrainingJobView[]>([])
const trainingActiveStatuses = ['queued', 'starting', 'processing'] as const
const activeTrainingCount = computed(() =>
  trainingJobs.value.filter(j => trainingActiveStatuses.includes(j.status as any)).length)
// Sort: active first (by nothing in particular), then terminal — newest API
// order is already newest-first, so keep relative order within each group.
const sortedTrainingJobs = computed(() => {
  const active = trainingJobs.value.filter(j => trainingActiveStatuses.includes(j.status as any))
  const done = trainingJobs.value.filter(j => !trainingActiveStatuses.includes(j.status as any))
  return [...active, ...done]
})
let trainingPollTimer: ReturnType<typeof setInterval> | null = null
// id → last seen status, to detect transitions for toasts. Plain object (not a
// Map — `Map` is shadowed by an imported icon component in this file).
const trainingPrevStatus: Record<string, string> = {}

async function fetchTrainingJobs() {
  try {
    const res = await fetch('/api/training-queue').then(r => r.json()) as { jobs?: TrainingJobView[] }
    const jobs = res.jobs ?? []
    for (const j of jobs) {
      const prev = trainingPrevStatus[j.id]
      // Only toast on a real transition (skip the first sighting, which would
      // re-announce jobs that finished while the app was closed).
      if (prev && prev !== j.status) {
        if (j.status === 'succeeded') {
          toast.success(`Training finished: ${j.displayName}`, {
            description: j.kind === 'voice' ? 'Voice ready in Generate speech.' : 'Style ready in your library.',
          })
          window.dispatchEvent(new CustomEvent(j.kind === 'voice' ? 'sailor:voicesUpdated' : 'sailor:lorasUpdated'))
        } else if (j.status === 'failed') {
          toast.error(`Training failed: ${j.displayName}`, { description: j.error || undefined })
        }
      }
      trainingPrevStatus[j.id] = j.status
    }
    trainingJobs.value = jobs
  } catch {
    // Server not ready / offline — keep last known state.
  }
}

async function cancelTraining(id: string) {
  try { await fetch(`/api/training-queue/${id}/cancel`, { method: 'POST' }) } catch {}
  fetchTrainingJobs()
}
async function dismissTraining(id: string) {
  try { await fetch(`/api/training-queue/${id}`, { method: 'DELETE' }) } catch {}
  fetchTrainingJobs()
}
function trainingStatusLabel(j: TrainingJobView): string {
  switch (j.status) {
    case 'queued': return 'Queued'
    case 'starting': return 'Starting…'
    case 'processing': return 'Training…'
    case 'succeeded': return 'Done'
    case 'failed': return 'Failed'
    case 'canceled': return 'Canceled'
  }
}

// Rich history items for the queue modal
interface HistoryItem {
  promptId: string
  status: 'completed' | 'failed'
  images: { filename: string, subfolder: string, type: string }[]
  executionTime: number | null // seconds
  timestamp: number // ms since epoch
}
const historyItems = ref<HistoryItem[]>([])

// Per-prompt fine progress (0-100) from bridge `progress`/`executed` events,
// keyed by prompt_id. Drives the queue panel and the active-run status bar.
const promptProgress = ref<Record<string, number>>({})

// The status bar and running-node label are now driven per-run (Tier 3): the
// old single globals (tabNodeProgress / currentRunningNode / executionStartTime
// / currentRunProgressPct) are gone for the DIRECT path. Instead the bar
// reflects the ACTIVE tab's in-flight registered run, resolved from the registry.
//
// BRIDGE-path carry: bridge runs never register, so the registry can't drive
// their bar. They keep a single-run display bag (bridgeDisplay) — the exact
// old-globals behavior, only populated for UNREGISTERED runs — used as the
// fallback when no registered run owns the active tab. This preserves today's
// status-bar behavior byte-for-byte when direct execution is off.
//
// Because perRun() state is a plain (non-reactive) Map, `runDisplayTick` is
// bumped on every per-run lifecycle mutation to re-run the computed;
// inFlightCount (reactive) covers registered run add/drop.
const runDisplayTick = ref(0)
const bridgeDisplay = ref<{ startedAt: number | null; runningNode: string; completed: number; total: number; percent: number }>(
  { startedAt: null, runningNode: '', completed: 0, total: 0, percent: 0 },
)
function resetBridgeDisplay() {
  bridgeDisplay.value = { startedAt: null, runningNode: '', completed: 0, total: 0, percent: 0 }
}
const activeRunDisplay = computed(() => {
  // Reactive deps: tick (per-run field mutations), inFlightCount (add/drop),
  // activeTabId (tab switch), promptProgress (fine percent), bridgeDisplay.
  void runDisplayTick.value
  void inFlightCount.value
  const tabId = activeTab.value?.type === 'project' ? activeTab.value.id : null
  if (!tabId) return null
  // Only real runs with a prompt_id drive the bar: skip reservations (empty
  // promptId, no RunState) and live-preview runs (silent by design).
  const runs = inFlight({ tabId }).filter((e) => e.promptId && !e.live)
  // Newest wins if several overlap on one tab — its label is what the user just
  // triggered.
  const entry = runs.sort((a, b) => b.startedAt - a.startedAt)[0]
  if (entry) {
    const st = perRun(entry.promptId)
    return {
      startedAt: entry.startedAt,
      progress: { completed: st.nodeProgress.completed, total: st.nodeProgress.total },
      runningNode: st.runningNode || '',
      percent: promptProgress.value[entry.promptId] ?? 0,
    }
  }
  // Bridge-path fallback: a single unregistered run in flight (direct exec off).
  const bd = bridgeDisplay.value
  if (bd.startedAt !== null) {
    return {
      startedAt: bd.startedAt,
      progress: { completed: bd.completed, total: bd.total },
      runningNode: bd.runningNode,
      percent: bd.percent,
    }
  }
  return null
})

// Latest result for the canvas status bar. Cleared when a new run starts;
// success auto-clears after a few seconds via the timeout below; errors
// persist until the user dismisses or the next run starts.
const lastRunResult = ref<RunResult | null>(null)
let successClearTimer: ReturnType<typeof setTimeout> | null = null

function setRunResult(r: RunResult | null) {
  if (successClearTimer) { clearTimeout(successClearTimer); successClearTimer = null }
  lastRunResult.value = r
  if (r?.kind === 'success') {
    successClearTimer = setTimeout(() => {
      if (lastRunResult.value?.kind === 'success') lastRunResult.value = null
    }, 6000)
  }
}

// Credits accounting for the run cost display.
//   - perRun(promptId).startCredits: balance at execution_start (the
//     "before" number) for THIS run. Per-run (not global — see Task 3's
//     executedNodeIds/outputs for the same pattern this mirrors) so two
//     concurrent credit-billed runs each keep their own baseline instead of
//     the second run's execution_start clobbering the first's. At
//     execution_complete this is snapshotted (while the RunState is still live)
//     into the run's pendingCredits entry, which survives finishRun.
//   - executedNodeIds (per-run, see lib/graph/runRegistry.ts perRun): every
//     node id that fired an `executing` event during a run. Used to estimate
//     the Replicate dollar cost from the price_badge of each node that ran
//     (BYOK Replicate doesn't show up in Comfy's credit balance, so we can't
//     use the delta there). Kept PER-RUN (not global) so concurrent runs
//     don't union each other's nodes into one inflated tally.
// We can't know either cost synchronously — Comfy/Replicate deduct mid-run
// and Pinia's balance only refreshes after we refetch. So at execution_complete
// we trigger a refresh, record a pendingCredits entry with a deadline, and
// watch `credits` until that deadline. The watch() call lives further down,
// after `credits` is declared, to avoid TDZ. When multiple runs are concurrently
// armed, resolveCreditDelta (see lib/graph/creditAttribution.ts) picks ONE to
// attribute the observed delta to — see that file's doc comment for the
// heuristic and its rationale.

// Output files collected from `executed` events during a run (per-run, see
// perRun(...).outputs) — the durable generation record is assembled from
// these at execution_complete.

// The durable-save payload assembled at execution_complete: which project to
// write into plus the GenerationRecord itself.
interface DurableGenPayload {
  projectUuid: string
  projectName?: string
  record: GenerationRecord
}

// A credit resolution + durable record waiting on the post-run balance refresh.
//
// CRITICAL: this map is DELIBERATELY decoupled from the run registry's RunState.
// execution_complete calls finishRun(prompt_id), which internally
// dropRunState()s the registered RunState — so a captured RunState reference is
// stale the instant finishRun returns, and any later perRun(id) lookup lazily
// hands back a BRAND-NEW EMPTY bag. The credit balance refetch lands ~2.5s AFTER
// execution_complete and the durable flush timer 9s after, both LONG past
// finishRun. Keeping the pending credit/record here (module-level, untouched by
// finishRun/dropRunState) is what lets watch(credits) and the 9s timer still
// find this run's real startCredits + record. Pre-fix, direct-mode registered
// runs lost BOTH the credit number and the durable record to that empty bag.
//
// Keyed by pcKey(prompt_id) so bridge-path runs (whose prompt_id may be
// null/undefined) collapse to one stable key ('_'), matching perRun's own
// `local_${id ?? '_'}` collapsing — a single bridge run resolves exactly once.
// Plain object, NOT `new Map()` — `Map` is shadowed by a lucide-vue-next icon
// import above.
interface PendingCredit {
  promptId: string | null
  startCredits: number | null   // captured at execution_complete from the still-live RunState
  deadline: number              // 0 = credit watch disabled (Replicate/BYOK run); else Date.now()+8000
  record: DurableGenPayload | null
  flushed: boolean
  timer: ReturnType<typeof setTimeout> | null
}
const pendingCredits: Record<string, PendingCredit> = {}

/** Stable map key for a prompt_id; null/undefined collapse to '_' (single bridge run). */
function pcKey(promptId: string | null | undefined): string {
  return promptId ?? '_'
}

// Resolves a pending credit entry: saves its durable record (stamping the
// credit delta if we have one) and removes the entry. Idempotent via `flushed`
// so the watch and the 9s timer can't double-save. Replaces the old
// per-RunState flushPendingGen for the credit path — it reads pendingCredits,
// which survives finishRun, instead of a RunState the registry may already have
// torn down.
function flushPendingCredit(promptId: string | null | undefined, creditsDelta?: number | null) {
  const pending = pendingCredits[pcKey(promptId)]
  if (!pending || pending.flushed) return
  pending.flushed = true
  if (pending.timer) clearTimeout(pending.timer)
  if (pending.record) {
    if (typeof creditsDelta === 'number' && creditsDelta > 0) pending.record.record.credits = creditsDelta
    useProjects().saveGeneration(pending.record.projectUuid, pending.record.record, pending.record.projectName)
    // Tell any open Assets panel a new generation just landed so it re-reads the
    // server list. Without this the panel only refreshes on open, so newly
    // generated images never show up until it's closed/reopened or reloaded.
    window.dispatchEvent(new CustomEvent('sailor:generationSaved'))
  }
  delete pendingCredits[pcKey(promptId)]
}

const promptNodeInfo = ref<Record<string, { nodeId: string, nodeType: string }>>({})

let queuePollTimer: ReturnType<typeof setInterval> | null = null
const credits = ref<number | null>(null)

// ── Hosted-mode wallet pill ─────────────────────────────────────────────
// In hosted mode the pill shows OUR wallet (Neon ledger via /api/wallet) and
// clicking it opens /account. The comfy.org credits plumbing (bridge
// credits_update events + purchase modal below) is deliberately KEPT intact
// — it is what local mode still shows, and hosted may re-use it for Comfy
// API nodes later.
// (`hostedShell` itself is declared at the top of setup — see the note there.)
const hostedWallet = ref<number | null>(null)
// Set when the wallet fetch comes back as the auth middleware's private-beta
// refusal (Stage 8) — a signed-in account that isn't on the beta allowlist.
// Drives the full-screen <BetaGate /> mounted in the template below.
const betaGated = ref(false)
async function refreshHostedWallet() {
  if (!hostedShell) return
  try {
    const w = await $fetch<{ mode: string; available?: number }>('/api/wallet')
    hostedWallet.value = w.mode === 'hosted' && typeof w.available === 'number' ? w.available : null
  } catch (e) {
    if (isBetaGateError(e)) betaGated.value = true
    hostedWallet.value = null /* signed out, gated, or transient — pill shows em dash */
  }
}
// The pill DISPLAYS this trailing value: on a balance change it counts from
// the old number to the new one (~700ms, easeOutCubic) instead of snapping,
// so a debit reads as the meter ticking down. First paint, sign-out, and
// reduced-motion users jump instantly (shouldAnimateWalletChange + the media
// query). The tween math is pure (lib/countTween.ts); only the rAF loop lives here.
const displayedWallet = ref<number | null>(null)
let walletTweenRaf = 0
const WALLET_TWEEN_MS = 900
if (import.meta.client && hostedShell) {
  watch(hostedWallet, (next, prev) => {
    cancelAnimationFrame(walletTweenRaf)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || !shouldAnimateWalletChange(prev ?? null, next ?? null)) {
      displayedWallet.value = next ?? null
      return
    }
    // Start from wherever the display currently is — a refresh landing
    // mid-animation retargets smoothly instead of restarting from the old
    // settled value.
    const from = displayedWallet.value ?? (prev as number)
    const to = next as number
    const start = performance.now()
    const step = (now: number) => {
      const t = (now - start) / WALLET_TWEEN_MS
      displayedWallet.value = tweenValue(from, to, t)
      if (t < 1) walletTweenRaf = requestAnimationFrame(step)
    }
    walletTweenRaf = requestAnimationFrame(step)
  })
  onMounted(() => {
    refreshHostedWallet()
    window.addEventListener('focus', refreshHostedWallet)
  })
  onUnmounted(() => {
    window.removeEventListener('focus', refreshHostedWallet)
    cancelAnimationFrame(walletTweenRaf)
  })
}
const creditsPillText = computed(() => {
  if (hostedShell) return hostedWallet.value !== null ? `${(displayedWallet.value ?? hostedWallet.value).toLocaleString()} credits` : '— credits'
  // Local mode: the operator pays providers directly — no credits to show.
  // The comfy.org credits plumbing (credits ref, bridge events, purchase
  // modal via UserPopup) stays dormant but intact in case it's needed again.
  return 'Local mode'
})
function onCreditsPillClick() {
  if (hostedShell) navigateTo('/account')
  // Local mode: informational pill, no action.
}

// Watch credits for the post-run delta. Must come after `credits` is declared.
// Multiple credit-billed runs can be in flight at once, each with its own entry
// in pendingCredits (which SURVIVES finishRun — see PendingCredit above).
// resolveCreditDelta picks which ONE to attribute this balance observation to
// (see lib/graph/creditAttribution.ts for the heuristic + rationale) so the
// record that gets the delta is always a specific run's, never a clobbered slot.
watch(credits, (newVal) => {
  if (newVal == null) return
  const result = lastRunResult.value
  if (result?.kind !== 'success') return
  if (result.cost != null || result.usd != null) return // already accounted for
  const now = Date.now()
  // Enumerate the ACTUAL pending-credit entries — not a single last-event id.
  // This is what fixes the concurrent-completions miss: two runs that complete
  // in the same tick each have their own pendingCredits entry, so both are
  // surfaced as candidates instead of only whichever completed last.
  // deadline maps onto the pure helper's costDeadline field 1:1.
  const candidates: CreditWatchCandidate[] = Object.values(pendingCredits).map((pc) => ({
    promptId: pc.promptId ?? '',
    startCredits: pc.startCredits,
    costDeadline: pc.deadline,
  }))
  const resolution = resolveCreditDelta(candidates, newVal, now)
  if (!resolution) return
  lastRunResult.value = { ...result, cost: resolution.delta }
  const resolvedId = resolution.promptId || null
  // Attribute + save the durable record (if this run has one) and remove the
  // entry. flushPendingCredit reads pendingCredits, which is still here even
  // though finishRun long ago dropped this run's RunState.
  flushPendingCredit(resolvedId, resolution.delta)
})
const userProfile = ref<{ email?: string | null, displayName?: string | null, photoURL?: string | null, uid?: string | null, providerId?: string | null } | null>(null)
const userPopupOpen = ref(false)

// Pre-run cost guard — promise-based confirm so runVueWorkflow can await it.
// FIFO queue (not a single slot): two independent threshold-crossing Runs each
// get their own request + promise, so the first is never dropped/hung by the
// second (audit R3). The dialog shows the queue HEAD; resolving it advances to
// the next. `costConfirmHead` is a reactive mirror of the head for the template
// (the queue itself is a plain class instance); onChange re-reads it after every
// mutation.
const costConfirmHead = ref<{ estimate: CostEstimate; iterations: number } | null>(null)
const costConfirmQueue = new CostConfirmQueue<CostEstimate>(() => {
  const h = costConfirmQueue.head
  costConfirmHead.value = h ? { estimate: h.estimate, iterations: h.iterations } : null
})
function confirmRunCost(estimate: CostEstimate, iterations = 1): Promise<boolean> {
  return costConfirmQueue.enqueue(estimate, iterations)
}
function resolveCostConfirm(ok: boolean) {
  costConfirmQueue.resolveHead(ok)
}
function costConfirmThresholdUsd(): number {
  const raw = useLocalSettings().getLocalSetting('Sailor.Cost.ConfirmThresholdUsd')
  const n = parseFloat(raw ?? '')
  return Number.isFinite(n) && n >= 0 ? n : 1
}

// Rolling estimate for the Run button. Polled (not computed) because the
// canvas nodes live behind a component ref, outside our reactivity graph.
const runEstimate = ref<CostEstimate | null>(null)
let runEstimateTimer: ReturnType<typeof setInterval> | null = null
function updateRunEstimate() {
  if (!vueNodesEnabled.value || activeTab.value?.type !== 'project') {
    runEstimate.value = null
    return
  }
  const nodes = vueCanvasRef.value?.getNodes?.() || []
  runEstimate.value = estimateUsdForNodes(vueNodesToEstimateInput(nodes), { hosted: hostedShell })
}

/** Per-iteration line in the confirm dialog. Hosted divides the CREDITS figure
 *  (an exact multiple — the estimate scaled it by the same iteration count)
 *  rather than re-converting a divided USD, which would ceil a second time. */
function perIterationCost(est: CostEstimate, iterations: number): string {
  const credits = est.hostedCredits != null ? Math.round(est.hostedCredits / iterations) : null
  return formatEstimateLong(est.usd / iterations, credits, hostedShell)
}

// Credits modal (native Vue — no iframe needed)
const creditsModalOpen = ref(false)
const creditsAmount = ref(50)
const creditsBuying = ref(false)
const creditsPresets = [10, 25, 50, 100]
const CREDITS_PER_DOLLAR = 211

const creditsDisplay = computed(() => Math.round(creditsAmount.value * CREDITS_PER_DOLLAR).toLocaleString())

function adjustCreditsAmount(delta: number) {
  const step = creditsAmount.value < 100 ? 5 : creditsAmount.value < 1000 ? 50 : 100
  creditsAmount.value = Math.max(5, Math.min(10000, creditsAmount.value + delta * step))
}

function openAddCredits() {
  creditsAmount.value = 50
  creditsModalOpen.value = true
}

function sendToBridgeIframe(action: string, payload?: any) {
  const bridgeIframe = document.getElementById('sailor-bridge-iframe') as HTMLIFrameElement
  if (bridgeIframe?.contentWindow) {
    bridgeIframe.contentWindow.postMessage({ type: 'sailor', action, ...payload }, '*')
  }
}

async function handleContinueToPayment() {
  creditsBuying.value = true
  sendToBridgeIframe('purchaseCredits', { amount: creditsAmount.value })
}


// Provide user state for sidebar avatar
provide('userProfile', userProfile)
provide('userPopupOpen', userPopupOpen)
provide('toggleUserPopup', () => { userPopupOpen.value = !userPopupOpen.value })

function toggleQueue() {
  queueOpen.value = !queueOpen.value
  if (queueOpen.value) {
    fetchQueueAndHistory()
    fetchTrainingJobs()
    queuePollTimer = setInterval(fetchQueueAndHistory, 2000)
  } else {
    if (queuePollTimer) { clearInterval(queuePollTimer); queuePollTimer = null }
  }
}

async function fetchQueueAndHistory() {
  const [queueRes, historyRes] = await Promise.allSettled([
    fetch('/queue').then(r => r.json()),
    fetch('/history').then(r => r.json()),
  ])

  if (queueRes.status === 'fulfilled') {
    queueData.value = {
      running: queueRes.value.queue_running ?? [],
      pending: queueRes.value.queue_pending ?? [],
    }
  }

  if (historyRes.status === 'fulfilled') {
    const data = historyRes.value as Record<string, any>
    const items: HistoryItem[] = []
    for (const [promptId, entry] of Object.entries(data)) {
      const status = entry.status?.completed ? 'completed' : 'failed'
      // Collect all output images across nodes
      const images: { filename: string, subfolder: string, type: string }[] = []
      if (entry.outputs) {
        for (const nodeOutput of Object.values(entry.outputs) as any[]) {
          if (nodeOutput.images) images.push(...nodeOutput.images)
        }
      }
      // Calculate execution time from messages
      let executionTime: number | null = null
      const messages = entry.status?.messages ?? []
      const startMsg = messages.find((m: any) => m[0] === 'execution_start')
      const endMsg = messages.find((m: any) => m[0] === 'execution_success' || m[0] === 'execution_error')
      if (startMsg?.[1]?.timestamp && endMsg?.[1]?.timestamp) {
        executionTime = (endMsg[1].timestamp - startMsg[1].timestamp) / 1000
      }
      const timestamp = startMsg?.[1]?.timestamp ?? 0
      // Skip live-preview entries (temp-only images from UI.PreviewImage) so
      // the queue history panel isn't flooded by slider-drag runs.
      const savedImages = images.filter(img => img.type !== 'temp')
      if (savedImages.length > 0) {
        items.push({ promptId, status, images: savedImages, executionTime, timestamp })
      }
    }
    // Sort newest first
    items.sort((a, b) => b.timestamp - a.timestamp)
    historyItems.value = items
  }
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return ''
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

function queueItemProgress(_promptId: string): number {
  // Use the active tab's progress — single source of truth
  const tab = tabs.value.find(t => t.type === 'project' && t.status === 'running')
  return tab?.progress ?? 0
}

function runningWorkflowName(promptId: string): string {
  // Find which tab is running this prompt by checking which tab has 'running' status
  const runningTab = tabs.value.find(t => t.type === 'project' && t.status === 'running')
  return runningTab?.label ?? 'Running'
}

function thumbnailUrl(img: { filename: string, subfolder: string, type: string }): string {
  const params = new URLSearchParams({ filename: img.filename, type: img.type })
  if (img.subfolder) params.set('subfolder', img.subfolder)
  return `/view?${params}`
}

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  if (date >= today) return 'Today'
  if (date >= yesterday) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Group history items by day
const groupedHistory = computed(() => {
  const groups: { label: string, items: HistoryItem[] }[] = []
  let currentLabel = ''
  for (const item of historyItems.value) {
    const label = dayLabel(item.timestamp)
    if (label !== currentLabel) {
      currentLabel = label
      groups.push({ label, items: [] })
    }
    groups[groups.length - 1].items.push(item)
  }
  return groups
})

// Listen for bridge messages from ComfyUI iframes
// Guard so the direct-execution onEvent callback registers only once even if
// the layout remounts (onEvent's Set dedupes identity, but each remount would
// otherwise add a fresh closure).
let directEventListenerRegistered = false

onMounted(async () => {
  // Vue mode: load workflow for the active project tab immediately (no iframe needed)
  if (vueNodesEnabled.value && activeTab.value.type === 'project') {
    await loadWorkflowForTab(activeTab.value)
  }

  // Debug: log ALL postMessages to find bridge issues
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'sailor-bridge') {
      console.log('[Sailor] Bridge message received:', e.data.event || e.data.status, e.data)
    }
  })
  window.addEventListener('message', handleBridgeMessage)
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('sailor:loadTabWorkflow', handleLoadTabWorkflow)

  // Direct-execution WS events must flow through the SAME window postMessage
  // pipe the bridge iframe uses (mapWsEvent already shapes them identically),
  // so BOTH this layout's own `handleBridgeMessage` listener AND
  // VueNodeCanvas's separate `window.addEventListener('message', ...)` (which
  // filters on the 'sailor-bridge' envelope) receive them. Re-dispatching as
  // a self-posted message — rather than calling handleBridgeEvent directly —
  // means node glow, take/output landing, red rings and gate_paused all light
  // up in direct mode, and the event flows exactly ONCE (no double-handling).
  // The `direct: true` marker lets handleBridgeMessage accept a same-window
  // source; VueNodeCanvas's eventWorker() maps the (non-iframe) source to
  // worker 0 / the active tab, which is correct for the single direct channel.
  if (!directEventListenerRegistered) {
    directEventListenerRegistered = true
    direct.onEvent((e) => {
      window.postMessage({ type: 'sailor-bridge', v: 2, direct: true, ...e }, window.location.origin)
    })
  }
  if (directExecutionEnabled.value) direct.connect()
  watch(directExecutionEnabled, (on) => {
    if (on) direct.connect()
    else direct.disconnect()
  })

  // Persistent training queue: poll for status (badge + toasts) regardless of
  // whether the Queue panel is open, and refresh immediately when a job is
  // enqueued from the Train tab.
  fetchTrainingJobs()
  trainingPollTimer = setInterval(fetchTrainingJobs, 5000)
  window.addEventListener('sailor:trainingQueueUpdated', fetchTrainingJobs)

  // Also check bridge iframe loaded after delay and request client ID
  setTimeout(() => {
    const bridge = document.getElementById('sailor-bridge-iframe') as HTMLIFrameElement
    console.log('[Sailor] Bridge iframe check:', {
      exists: !!bridge,
      src: bridge?.src,
      display: bridge ? getComputedStyle(bridge).display : 'N/A',
    })
  }, 5000)
})

onUnmounted(() => {
  window.removeEventListener('message', handleBridgeMessage)
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('sailor:loadTabWorkflow', handleLoadTabWorkflow)
  window.removeEventListener('sailor:trainingQueueUpdated', fetchTrainingJobs)
  if (queuePollTimer) { clearInterval(queuePollTimer); queuePollTimer = null }
  if (trainingPollTimer) { clearInterval(trainingPollTimer); trainingPollTimer = null }
  direct.disconnect()
})

const { settingsOpen, openSettings, closeSettings } = useSettingsModal()

function handleGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (creditsModalOpen.value) creditsModalOpen.value = false
    else if (settingsOpen.value) closeSettings()
    else if (userPopupOpen.value) userPopupOpen.value = false
  }

  // Space key: open Vue node search dialog
  if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    if (activeTab.value.type !== 'project') return
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return
    if ((e.target as HTMLElement)?.isContentEditable) return
    e.preventDefault()
    openNodeSearch()
  }
}

function handleSignOut() {
  // Hosted has no bridge iframe (direct execution forced), so the bridge
  // 'signOut' message goes nowhere — end the Clerk session directly and
  // land signed out on the homepage. window.Clerk avoids a setup-context
  // composable in a layout that must also compile in local mode.
  const clerk = (window as any).Clerk
  if (hostedShell && clerk?.signOut) {
    userPopupOpen.value = false
    void clerk.signOut().then(() => window.location.assign('/'))
    return
  }
  sendToBridgeIframe('signOut')
}

function handleOpenBilling() {
  sendToBridgeIframe('openBillingPortal')
  userPopupOpen.value = false
}

// Thin wrapper over the postMessage listener: unwrap the bridge envelope and
// hand the payload to handleBridgeEvent. Direct-execution WS events are routed
// through the SAME handleBridgeEvent (via direct.onEvent) so both channels share
// one code path — see the onEvent registration in onMounted.
function handleBridgeMessage(event: MessageEvent) {
  if (!event.data || event.data.type !== 'sailor-bridge') return
  handleBridgeEvent(event.data, event.source as Window | null)
}

// Per-event silent determination (audit C4). A "silent" run (live-preview /
// slider drag) suppresses status-bar + tab-indicator UI. Two sources, by path:
//   - DIRECT (registered) runs carry their own `live` flag on the run entry
//     (stamped at registerRun), so we read getRun(prompt_id)?.live — this is
//     per-run, so a live run overlapping a real run can NEVER mis-tag the real
//     run silent (the C4 bug the old single global caused).
//   - BRIDGE-path (unregistered) runs never register, so getRun is null; they
//     fall back to the single `currentRunSilent` flag, which ComfyUI's
//     one-prompt-at-a-time bridge model makes safe (see pendingLiveRuns). This
//     preserves today's behavior byte-for-byte when direct execution is off.
function isSilentEvent(prompt_id: string | undefined | null): boolean {
  if (prompt_id) {
    const entry = getRun(prompt_id)
    if (entry) return entry.live // registered → per-run truth
  }
  return currentRunSilent.value // bridge/unregistered → single flag fallback
}

function handleBridgeEvent(data: any, source?: Window | null) {
  if (!data) return

  // Bridge signals ComfyUI is fully initialized and ready for workflow loads
  if (data.status === 'ready') {
    markBridgeReady() // global (worker-0 / single-worker path)
    if (poolEnabled.value) {
      const w = workerIndexOfFrame(source as Window)
      if (w != null) markWorkerReady(w)
    }
    return
  }

  // Bridge confirms a workflow finished loading into the canvas
  if (data.event === 'workflow_loaded') {
    endWorkflowLoading()
    return
  }

  // Handle credit updates (not tab-specific)
  if (data.event === 'credits_update') {
    credits.value = data.credits
    return
  }

  // Handle user profile data
  if (data.event === 'user_profile') {
    userProfile.value = data.profile
    return
  }

  // Handle sign out confirmation
  if (data.event === 'signed_out') {
    userProfile.value = null
    credits.value = null
    userPopupOpen.value = false
    return
  }

  // Handle checkout URL from bridge (after purchaseCredits)
  if (data.event === 'checkout_url') {
    creditsBuying.value = false
    creditsModalOpen.value = false
    if (data.url) {
      window.open(data.url, '_blank')
    }
    return
  }

  // Handle purchase error
  if (data.event === 'purchase_error') {
    creditsBuying.value = false
    return
  }

  // Queue failed inside the canvas (validation / unknown node / serialization)
  // before anything ran — surface it instead of failing silently. When the
  // bridge forwards ComfyUI's structured node_errors map (prompt validation:
  // type mismatches, missing inputs, bad combo values), show a per-node
  // summary. The offending nodes get their red rings via VueNodeCanvas, which
  // listens to the same bridge postMessage directly (the exact path
  // execution_error events take — no re-dispatch needed).
  if (data.event === 'queue_error') {
    // Metering refusals get their own specific toast in VueNodeCanvas's
    // bridge handler (same postMessage, listened to directly) — suppress
    // the generic fallback here so the user doesn't see two toasts, but
    // still run the state cleanup (watchdog, tab status, silent flag).
    const refusal = describeQueueRefusal(data)
    surfaceQueueError(data.node_errors, data.message, { silent: !!refusal })
    return
  }

  // Bridge acked a successful queue (POST /prompt returned a prompt_id) — the
  // run is on its way, so cancel the no-response watchdog. (Bridges predating
  // this event fall back to the execution_start clear below.)
  if (data.event === 'queued') {
    clearQueueWatchdog()
    return
  }

  // Non-fatal bridge diagnostics that the user must act on — e.g. the iframe's
  // LiteGraph node registry is stale after a ComfyUI restart (it dropped a
  // Timeline's edit_state at configure) and only a page reload can fix it.
  if (data.event === 'bridge_warning') {
    const msg = String(data.message || 'The ComfyUI canvas reported a problem.')
    toast.warning('ComfyUI needs a reload', { description: msg.slice(0, 160) })
    return
  }

  // Space key forwarded from iframe → open Vue node search dialog
  if (data.event === 'open_node_search') {
    if (activeTab.value.type === 'project') {
      openNodeSearch()
    }
    return
  }

  // Debug messages from bridge
  if (data.event === 'debug') {
    console.log('[Sailor Debug]', data.msg)
    return
  }

  // Find which tab this iframe belongs to. Direct-execution WS events carry no
  // source Window (source is undefined) — they fall through to the
  // active-project-tab fallback below. Cast mirrors the original bridge path.
  const sourceFrame = source as Window
  const projectTabs = tabs.value.filter((t) => t.type === 'project')

  let tabId: string | null = null

  // Pool: route by the worker that sent the event → the tab running on it. This
  // lets a background canvas (not the active one) keep updating while another
  // runs. Only when the pool is enabled — single-worker keeps the logic below.
  if (poolEnabled.value) {
    const w = workerIndexOfFrame(sourceFrame)
    if (w != null && workerRunningTab[w]) tabId = workerRunningTab[w]
  }

  // Find matching tab by checking iframes
  if (!tabId) {
    for (const tab of projectTabs) {
      const iframe = document.querySelector(`[data-tab-id="${tab.id}"] iframe`) as HTMLIFrameElement
      if (iframe?.contentWindow === sourceFrame) {
        tabId = tab.id
        break
      }
    }
  }

  // Fallback: use active project tab
  if (!tabId) {
    const activeProject = projectTabs.find((t) => t.id === activeTabId.value)
    if (activeProject) tabId = activeProject.id
  }

  const { event: evt, percent, prompt_id, node_id } = data

  // Registry attribution (direct mode): if this event carries a prompt_id the
  // run registry knows, that run's originating tab wins over the active-tab
  // fallback above — so a background/other-worker canvas keeps updating. Events
  // with no prompt_id, or a prompt_id not in the registry (bridge-path runs),
  // keep the tab resolved above unchanged.
  //
  // Direct-run STALL watchdog: any event for a live run RE-ARMS its no-event
  // stall timer (the run is demonstrably alive). Terminal events additionally
  // CLEAR it in their own branches below (execution_complete/execution_error),
  // so a completed run stops re-arming. rearm is a no-op once cleared.
  if (prompt_id) {
    rearmDirectRunWatchdog(prompt_id)
    tabId = resolveEventTab(prompt_id, tabId)
  }

  if (!tabId) return

  if (evt === 'execution_start') {
    clearQueueWatchdog() // run reached the server — fallback clear for older bridges
    if (prompt_id) markRunning(prompt_id) // registry no-op for bridge-path runs
    // Silent-claim (audit C4). REGISTERED (direct) runs already carry their own
    // `live` flag on the entry, so isSilentEvent reads that per-run and we must
    // NOT touch the bridge globals here (doing so is exactly the C4 mis-tag: a
    // live run's execution_start would flip currentRunSilent under an overlapping
    // real run). For UNREGISTERED (bridge-path) runs, keep the single-flag
    // mechanism: consume a pending live-run and set currentRunSilent, before any
    // UI update so the tab indicator can skip too.
    const registered = !!(prompt_id && getRun(prompt_id))
    if (!registered) {
      if (pendingLiveRuns.value > 0) {
        pendingLiveRuns.value--
        currentRunSilent.value = true
      } else {
        currentRunSilent.value = false
      }
    }
    const silent = isSilentEvent(prompt_id)
    // Bridge-path display: only unregistered runs use the single-run bag; a
    // registered run's status bar is driven from its registry entry instead.
    if (!registered) {
      bridgeDisplay.value = { startedAt: Date.now(), runningNode: '', completed: 0, total: 0, percent: 0 }
    }
    runDisplayTick.value++
    if (prompt_id) {
      promptProgress.value[prompt_id] = 0
    }
    // Registered (direct-mode) runs already get a fresh RunState from
    // registerRun, so this only matters for bridge-path / unregistered runs,
    // which share one stable transient bag per prompt_id key (see perRun in
    // runRegistry.ts) that otherwise persists across runs. If the PREVIOUS run
    // under this key left a pendingCredits entry still waiting on a credit
    // delta, flush it as-is BEFORE this run overwrites that entry at its own
    // execution_complete — otherwise the previous run's record would be
    // silently discarded. flushPendingCredit is keyed by pcKey(prompt_id), so
    // it touches only THIS key's entry, never another run's.
    flushPendingCredit(prompt_id)
    // Drop the (bridge-path) transient RunState bag so the next perRun() read
    // below recreates it empty, preserving the old "clear the global on start"
    // semantics for that single-transient case. No-op for registered runs
    // (registerRun already gave them a fresh bag).
    dropRunState(prompt_id)
    // Snapshot the credits balance so we can show "−N credits" on success.
    // Done regardless of silent so the math is right even if the user's
    // first live-run is followed by a real Run. Per-run (perRun(prompt_id),
    // not a global) so a second concurrent credit-billed run's
    // execution_start can't clobber the first run's baseline.
    perRun(prompt_id).startCredits = credits.value
    // New run wipes any prior result from the status bar — the user wants
    // to know about THIS run, not the last one.
    if (!silent) {
      updateTabStatus(tabId, 'running', 0)
      setRunResult(null)
    }
  } else if (evt === 'progress') {
    if (!isSilentEvent(prompt_id)) updateTabStatus(tabId, 'running', percent)
    if (prompt_id) promptProgress.value[prompt_id] = percent
    // Bridge-path (unregistered) fine percent → single-run display bag.
    if (typeof percent === 'number' && !(prompt_id && getRun(prompt_id))) {
      bridgeDisplay.value = { ...bridgeDisplay.value, percent }
    }
  } else if (evt === 'executing' && node_id) {
    // Count total nodes for coarse progress — per-run (audit C5): scoped to THIS
    // prompt_id so an overlapping run B's execution_start can't reset A's counter
    // and drop A as a silent-failure at its own execution_complete.
    perRun(prompt_id).nodeProgress.total++
    // Remember which nodes ran — needed for the Replicate USD cost estimate
    // at execution_complete (BYOK runs don't move Comfy's credit balance).
    // Per-run (not global): scoped to THIS prompt_id so concurrent runs don't
    // union each other's executed nodes into one inflated tally.
    perRun(prompt_id).executedNodeIds.add(String(node_id))
    // Look up display name from Vue canvas nodes
    const vueNodes = vueCanvasRef.value?.getNodes?.() || []
    const vueNode = vueNodes.find((n: any) => n.id === String(node_id))
    const displayName = vueNode?.data?.title || node_id
    if (prompt_id) {
      promptNodeInfo.value[prompt_id] = { nodeId: node_id, nodeType: displayName }
    }
    // Per-run running-node label (drives the ACTIVE tab's status bar via
    // activeRunDisplay). Per-run so a background run's node name can't hijack
    // the label shown for the foreground run.
    perRun(prompt_id).runningNode = displayName
    // Bridge-path (unregistered) runs: mirror the label + running total into the
    // single-run display bag, since their bar reads bridgeDisplay, not the registry.
    if (!(prompt_id && getRun(prompt_id))) {
      bridgeDisplay.value = { ...bridgeDisplay.value, runningNode: String(displayName), total: perRun(prompt_id).nodeProgress.total }
    }
    // Poke the display recompute — perRun mutations are non-reactive.
    runDisplayTick.value++
  } else if (evt === 'executed') {
    if (data.output) perRun(prompt_id).outputs.push(...extractOutputFiles(data.output))
    // Track node completion for coarse progress — per-run (audit C5).
    const np = perRun(prompt_id).nodeProgress
    np.completed++
    runDisplayTick.value++
    if (np.total > 0) {
      const coarsePct = Math.round((np.completed / np.total) * 100)
      if (!isSilentEvent(prompt_id)) updateTabStatus(tabId, 'running', coarsePct)
      if (prompt_id) promptProgress.value[prompt_id] = coarsePct
    }
    // Bridge-path display: mirror completed count + coarse percent.
    if (!(prompt_id && getRun(prompt_id))) {
      bridgeDisplay.value = {
        ...bridgeDisplay.value,
        completed: np.completed,
        total: np.total,
        percent: np.total > 0 ? Math.round((np.completed / np.total) * 100) : bridgeDisplay.value.percent,
      }
    }
  } else if (evt === 'execution_complete') {
    if (prompt_id) clearDirectRunWatchdog(prompt_id) // run is done — stop the stall timer
    // Hosted: drop the wallet pill as soon as the run settles. Settlement is a
    // separate server step that lags the completion event, so fire again after
    // it has had time to land — the first refresh often still reads the hold.
    if (hostedShell) {
      void refreshHostedWallet()
      setTimeout(() => { void refreshHostedWallet() }, 3000)
    }
    // Duration: registered runs carry startedAt on their entry; bridge-path runs
    // read the single-run display bag. Read BEFORE finishRun drops the entry.
    const startEntry = prompt_id ? getRun(prompt_id) : null
    const startAt = startEntry?.startedAt ?? bridgeDisplay.value.startedAt
    const durationMs = startAt ? (Date.now() - startAt) : 0
    // Detect a silent failure: complete fired but Comfy validation rejected the
    // prompt (no executed nodes, no node ran). Read this run's OWN per-run node
    // progress (audit C5) — an overlapping run B can no longer zero A's counter.
    const validatedRun = perRun(prompt_id).nodeProgress.completed > 0
    // Silent state for THIS run, snapshotted BEFORE finishRun drops the entry
    // (getRun would then go null). Registered → per-run live flag; bridge → the
    // single currentRunSilent flag.
    const completeWasSilent = isSilentEvent(prompt_id)
    // Capture this run's per-run state BEFORE finishRun (below) drops it —
    // finishRun tears down the registered RunState for `prompt_id`, so reading
    // perRun() after that would hand back a brand-new, empty bag instead of
    // this run's actual executed-node set / outputs / credit baseline. Every
    // value we need past finishRun is snapshotted into a local here; the
    // durable record + credit resolution then live in pendingCredits (which
    // finishRun does NOT touch), so watch(credits) 2.5s later and the 9s timer
    // still find them even though the RunState is long gone.
    const runState = perRun(prompt_id)
    const runExecutedNodeIds = runState.executedNodeIds
    // RunState.outputs is typed as the registry's generic GenOutputLike[] (the
    // registry has no dependency on lib/generations.ts); every push site here
    // is extractOutputFiles(...), which always produces real GenOutput shapes.
    const runOutputs = runState.outputs as GenOutput[]
    // Credit baseline snapshot — read from the STILL-LIVE RunState before
    // finishRun drops it. This is the "before" number the credit delta subtracts.
    const runStartCredits = runState.startCredits
    // The run's OWN node catalog, captured at dispatch (see runVueWorkflow). Read
    // BEFORE finishRun drops the RunState. Cost is priced against THESE nodes, not
    // the active tab's currently-displayed getNodes() (ids collide across canvases,
    // so a run completing while another canvas is shown would otherwise price its
    // executed-node set against unrelated nodes). Empty for bridge/transient runs
    // → fall back to live getNodes() (single-canvas anyway, byte-identical).
    const runEstimateNodes = runState.estimateNodes.length
      ? runState.estimateNodes
      : (vueCanvasRef.value?.getNodes?.() || [])
    // Clear the bridge single-run display (no-op for a registered run, whose bar
    // is driven off the registry and clears when finishRun removes the entry).
    resetBridgeDisplay()
    runDisplayTick.value++
    if (prompt_id) {
      delete promptProgress.value[prompt_id]
      delete promptNodeInfo.value[prompt_id]
      finishRun(prompt_id, 'done') // remove this run before the tab-drain check below (registry no-op for bridge runs)
    }
    // wasSilent: read the per-run/bridge silent state for THIS run BEFORE we
    // reset it. finishRun already dropped the registered entry, so re-reading
    // getRun here would be null — capture it above via a snapshot instead.
    const wasSilent = completeWasSilent
    currentRunSilent.value = false
    // Durable generation record — silent/live runs count too (they spend real
    // money). Fire-and-forget; never blocks the UI path.
    const runProjectUuid = projectTabs.find((t) => t.id === tabId)?.projectUuid || null
    const replicateEstimate = validatedRun
      ? tallyReplicateUsd(runExecutedNodeIds, runEstimateNodes)
      : null
    // Assemble the durable record (if this run produced one) so it can be
    // stashed in pendingCredits below. Built here — not on the RunState — so it
    // survives finishRun. A Replicate run flushes it immediately; a Comfy-native
    // run holds it in pendingCredits until watch(credits) resolves the delta or
    // the 9s timer times out.
    let pendingRecord: DurableGenPayload | null = null
    if (runProjectUuid && validatedRun && (runOutputs.length || replicateEstimate)) {
      const runDoc = savedWorkflows[tabId]
      // Resolve executed-node ids against the run's OWN catalog (runEstimateNodes),
      // not the active tab's displayed nodes — same collision-avoidance as the tally.
      const ranTypes = [...runExecutedNodeIds]
        .map((id) => runEstimateNodes.find((n: any) => n.id === id)?.data?.nodeType)
        .filter(Boolean) as string[]
      pendingRecord = {
        projectUuid: runProjectUuid,
        projectName: projectTabs.find((t) => t.id === tabId)?.label,
        record: {
          promptId: prompt_id || `local_${Date.now().toString(36)}`,
          ts: Date.now(),
          // The run's OWN canvas (stamped at registerRun, snapshotted in startEntry
          // before finishRun dropped it), NOT the tab's currently-active canvas —
          // a run completing after the user switched canvases still records where it
          // ran. Fall back to the tab's active canvas for bridge/unregistered runs.
          canvasId: startEntry?.canvasId ?? (isProjectDoc(runDoc) ? runDoc.activeCanvasId : null),
          outputs: [...runOutputs],
          usd: replicateEstimate?.usd ?? null,
          usdApproximate: replicateEstimate?.approximate ?? false,
          credits: null,
          nodes: [...new Set(ranTypes)],
        },
      } satisfies DurableGenPayload
    }
    // Did any Replicate (BYOK, dollar-billed) node run? If yes, that's the
    // user's true cost surface — Comfy's credit balance won't move, so we don't
    // arm the credit watch. This decision is independent of wasSilent: silent
    // runs still spend real money and must save their record + resolve their
    // credit exactly like a visible run.
    const isReplicate = !!replicateEstimate
    // Arm the credit watch for a validated Comfy-native run (record or not — a
    // recordless validated run still needs the delta for the lastRunResult.cost
    // display). Replicate/silent-invalid runs stay unarmed (deadline 0).
    const armCreditWatch = validatedRun && !isReplicate && lastRunResult.value?.kind !== 'error'
    const deadline = armCreditWatch ? Date.now() + 8000 : 0

    // Stash the credit resolution + durable record in pendingCredits, which
    // OUTLIVES finishRun (see PendingCredit above). This is THE fix: the entry
    // survives so watch(credits) 2.5s later and the 9s timer can still find this
    // run's startCredits + record — pre-fix they hit a fresh empty RunState bag
    // and lost both the credit number and the record for direct-mode runs.
    // Create the entry when there's a record to save OR a credit watch to
    // resolve; otherwise there's nothing pending.
    if (pendingRecord || armCreditWatch) {
      const pc: PendingCredit = {
        promptId: prompt_id ?? null,
        startCredits: runStartCredits,
        deadline,
        record: pendingRecord,
        flushed: false,
        timer: null,
      }
      pendingCredits[pcKey(prompt_id)] = pc
      if (isReplicate) {
        // Replicate run — balance won't move; flush the record now with its USD
        // estimate already baked in (no credit delta to wait for).
        flushPendingCredit(prompt_id)
      } else if (armCreditWatch) {
        // Comfy-native run — kick off the credit refresh. Pinia's cached balance
        // won't know about the deduction until we refetch. Two-stage refresh
        // covers Firestore propagation latency. watch(credits) resolves the
        // delta (and flushes the record) within the deadline; this 9s timer is
        // the fallback that flushes the record with an unknown delta if the
        // balance never moves. Whichever fires first deletes the entry (the
        // other no-ops via `flushed`). This self-cleaning pair replaces the old
        // 8.1s fallback sweep entirely — there is no leaked entry to sweep.
        sendToBridgeIframe('refreshCredits')
        setTimeout(() => sendToBridgeIframe('refreshCredits'), 2500)
        pc.timer = setTimeout(() => flushPendingCredit(prompt_id, null), 9000)
      } else {
        // Record-only path with no credit watch (e.g. a SILENT Comfy run: it
        // saves its record but doesn't chase the balance). Flush it after the
        // same 9s grace so any in-flight refresh has a chance, then delete.
        pc.timer = setTimeout(() => flushPendingCredit(prompt_id, null), 9000)
      }
    }

    // Does this tab still have OTHER direct runs in flight? finishRun above
    // already removed THIS run, so this counts only the rest. Bridge-path runs
    // never register, so inFlight is empty and this is false — preserving
    // today's single-run 'done' → 'idle' flash verbatim. When true, we keep the
    // tab's spinner (skip 'done'/'idle') but still record this run's result.
    const tabStillRunning = tabId ? inFlight({ tabId }).length > 0 : false
    if (!wasSilent) {
      if (!tabStillRunning) updateTabStatus(tabId, 'done')
      if (validatedRun && lastRunResult.value?.kind !== 'error') {
        setRunResult({
          kind: 'success',
          durationMs,
          at: Date.now(),
          usd: replicateEstimate?.usd ?? null,
          usdApproximate: replicateEstimate?.approximate ?? false,
        })
      }
      // Reset to idle after a brief moment — but only if no other run reclaims
      // this tab in the meantime (re-check at fire time, not just now).
      if (!tabStillRunning) {
        setTimeout(() => {
          if (tabId && inFlight({ tabId }).length > 0) return
          updateTabStatus(tabId!, 'idle')
        }, 3000)
      }
    }
    // Refresh history if queue panel is open
    if (queueOpen.value) fetchQueueAndHistory()
    // Nothing in flight anywhere → sweep any orphaned run visuals (glow state
    // stranded by an HMR mid-run, or events lost to a dropped socket, would
    // otherwise shimmer forever now that unknown prompt_ids no-op).
    if (inFlight().length === 0) vueCanvasRef.value?.clearAllRunVisuals?.()
    // Tear down this run's RunState. finishRun (above) already dropped it from
    // the registry for registered (direct-mode) runs; this additionally covers
    // bridge-path/unregistered prompt_ids, whose transient bag finishRun never
    // touches. Safe to drop unconditionally now — the credit path no longer
    // depends on the RunState surviving (it lives in pendingCredits instead).
    dropRunState(prompt_id)
  } else if (evt === 'execution_error') {
    if (prompt_id) clearDirectRunWatchdog(prompt_id) // run is terminal — stop the stall timer
    // Hosted: a failed run releases its hold server-side, so the pill must
    // recover — same two-step refresh as execution_complete (the first read
    // often still sees the hold; settlement lags the event).
    if (hostedShell) {
      void refreshHostedWallet()
      setTimeout(() => { void refreshHostedWallet() }, 3000)
    }
    // Snapshot silent state for THIS run BEFORE finishRun drops the entry
    // (getRun would then go null). Registered → per-run live; bridge → the flag.
    const errWasSilent = isSilentEvent(prompt_id)
    // Remove this run first, then idle the tab only if it has no other run in
    // flight — a second concurrent direct run must keep the spinner up. Bridge
    // runs aren't registered, so inFlight is empty and this idles as before.
    if (prompt_id) finishRun(prompt_id, 'error')
    const tabDrained = tabId ? inFlight({ tabId }).length === 0 : true
    if (!errWasSilent && tabDrained) updateTabStatus(tabId, 'idle')
    if (inFlight().length === 0) vueCanvasRef.value?.clearAllRunVisuals?.()
    resetBridgeDisplay()
    runDisplayTick.value++
    const wasSilent = errWasSilent
    currentRunSilent.value = false
    if (!wasSilent) {
      const nodeName = data.node_type || data.node_id || 'Unknown node'
      const reason = data.exception_message || 'Unknown error'
      setRunResult({ kind: 'error', nodeName, message: reason, at: Date.now() })
      toast.error(`${nodeName} failed`, { description: String(reason).slice(0, 200) })
    }
    // Tear down this run's per-run state. finishRun (above) already dropped it
    // for registered runs; this additionally covers the bridge-path transient
    // bag, which finishRun never touches.
    dropRunState(prompt_id)
  }
}

function stopFromStatusBar() {
  stopVueWorkflow()
}
function dismissRunResult() {
  setRunResult(null)
}
</script>

<template>
  <div class="flex h-screen bg-sidebar">
    <!-- Hidden bridge iframe: mounted so credits/auth work on all pages.
         NOT in hosted mode — the engine origin isn't reachable from a hosted
         browser, and mounting it is the exact hole that let the iframe post
         straight to the engine unmetered. -->
    <iframe
      v-if="!hostedShell && !directExecutionEnabled"
      id="sailor-bridge-iframe"
      :src="`${comfyOrigin}/`"
      class="fixed w-[10px] h-[10px] -left-[100px] -top-[100px] opacity-0 pointer-events-none"
      aria-hidden="true"
      tabindex="-1"
    />

    <!-- Parallel-run prototype: one hidden execution iframe per extra worker
         (index >= 1). Worker 0 is the main comfyui-shared canvas iframe below.
         Rendered only when the pool is enabled, so single-worker is untouched.
         Never in hosted mode — same unmetered-engine-access reason as above. -->
    <template v-if="!hostedShell && !directExecutionEnabled">
      <iframe
        v-for="i in (comfyWorkers.length - 1)"
        :key="`worker-${i}`"
        :data-worker="i"
        :src="`${comfyWorkers[i]}/`"
        class="fixed w-[10px] h-[10px] -left-[300px] -top-[300px] opacity-0 pointer-events-none"
        aria-hidden="true"
        tabindex="-1"
      />
    </template>

    <!-- Pre-run cost confirm -->
    <div
      v-if="costConfirmHead"
      class="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60"
      @click.self="resolveCostConfirm(false)"
    >
      <div class="w-[360px] bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl shadow-2xl p-4">
        <div class="text-sm font-semibold text-white mb-1">
          This run costs {{ formatEstimateLong(costConfirmHead.estimate.usd, costConfirmHead.estimate.hostedCredits, hostedShell) }}
        </div>
        <div v-if="costConfirmHead.iterations > 1" class="text-[11px] text-white/50 mb-2">
          {{ costConfirmHead.iterations }} runs × {{ perIterationCost(costConfirmHead.estimate, costConfirmHead.iterations) }} each
        </div>
        <div class="max-h-[160px] overflow-y-auto mb-3 space-y-1">
          <div
            v-for="item in costConfirmHead.estimate.breakdown"
            :key="item.id"
            class="flex items-center justify-between gap-3 text-[11px] text-white/60"
          >
            <span class="truncate">{{ item.label }}</span>
            <span class="tabular-nums shrink-0">{{ formatCostBadge(item.usd, false, hostedShell) }}</span>
          </div>
        </div>
        <div class="flex items-center justify-end gap-2">
          <button
            class="px-3 py-1.5 rounded-lg text-xs text-white/70 hover:bg-white/10 transition-colors cursor-pointer"
            @click="resolveCostConfirm(false)"
          >Cancel</button>
          <button
            class="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-action hover:bg-palette-blue/80 transition-colors cursor-pointer"
            @click="resolveCostConfirm(true)"
          >Run anyway</button>
        </div>
      </div>
    </div>

    <!-- Credits modal -->
    <Transition
      enter-active-class="transition-all duration-200 ease-out"
      leave-active-class="transition-all duration-150 ease-in"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="creditsModalOpen"
        class="fixed inset-0 z-[10000] flex items-center justify-center"
      >
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/50" @click="creditsModalOpen = false" />
        <!-- Modal -->
        <div class="relative w-[380px] bg-[#1e1e1e] border border-[#3a3a3a] rounded-[16px] shadow-2xl p-6">
          <!-- Header -->
          <div class="flex items-center justify-between mb-5">
            <h2 class="text-base font-semibold text-white">Add more credits</h2>
            <button class="text-white/40 hover:text-white transition-colors cursor-pointer" @click="creditsModalOpen = false">
              <X class="size-4" />
            </button>
          </div>

          <!-- Preset amounts -->
          <div class="mb-4">
            <label class="text-xs text-white/50 mb-2 block">Select amount</label>
            <div class="grid grid-cols-4 gap-2">
              <button
                v-for="preset in creditsPresets"
                :key="preset"
                class="py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer border"
                :class="creditsAmount === preset
                  ? 'bg-white/10 border-white/30 text-white'
                  : 'bg-[#2a2a2a] border-[#3a3a3a] text-white/70 hover:bg-[#333]'"
                @click="creditsAmount = preset"
              >
                ${{ preset }}
              </button>
            </div>
          </div>

          <!-- Amount + Credits inputs -->
          <div class="grid grid-cols-2 gap-3 mb-5">
            <div>
              <label class="text-xs text-white/50 mb-1.5 block">Amount (USD)</label>
              <div class="flex items-center bg-[#2a2a2a] border border-[#3a3a3a] rounded-lg">
                <button class="px-2.5 py-2 text-white/50 hover:text-white transition-colors cursor-pointer" @click="adjustCreditsAmount(-1)">
                  <Minus class="size-3.5" />
                </button>
                <span class="flex-1 text-center text-sm font-medium text-white">$ {{ creditsAmount }}</span>
                <button class="px-2.5 py-2 text-white/50 hover:text-white transition-colors cursor-pointer" @click="adjustCreditsAmount(1)">
                  <Plus class="size-3.5" />
                </button>
              </div>
            </div>
            <div>
              <label class="text-xs text-white/50 mb-1.5 block">Credits</label>
              <div class="flex items-center bg-[#2a2a2a] border border-[#3a3a3a] rounded-lg px-3 py-2">
                <span class="text-sm font-medium text-white">✦ {{ creditsDisplay }}</span>
              </div>
            </div>
          </div>

          <!-- Continue to payment -->
          <button
            class="w-full py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer"
            :class="creditsBuying
              ? 'bg-white/50 text-neutral-900/50 cursor-wait'
              : 'bg-white text-neutral-900 hover:bg-white/90'"
            :disabled="creditsBuying"
            @click="handleContinueToPayment"
          >
            {{ creditsBuying ? 'Processing...' : 'Continue to payment' }}
          </button>

          <!-- Pricing link -->
          <a
            href="https://www.comfy.org/pricing"
            target="_blank"
            class="flex items-center justify-center gap-1 mt-3 text-xs text-white/40 hover:text-white/60 transition-colors"
          >
            View pricing details
            <ExternalLink class="size-3" />
          </a>
        </div>
      </div>
    </Transition>

    <!-- Settings modal -->
    <SettingsModal />

    <!-- User popup -->
    <UserPopup
      :open="userPopupOpen"
      :user="userProfile"
      :credits="credits"
      @close="userPopupOpen = false"
      @sign-out="handleSignOut"
      @open-settings="openSettings(); userPopupOpen = false"
      @open-billing="handleOpenBilling"
      @open-add-credits="openAddCredits"
    />

    <AppSidebar />
    <div class="flex flex-1 flex-col min-w-0">
      <!-- Tab bar -->
      <div class="flex items-center pt-[19px] bg-[#0a0a0a]">
        <!-- Tabs -->
        <div class="tab-strip flex items-end flex-1 min-w-0 overflow-x-auto">
          <template v-for="(tab, index) in tabs" :key="tab.id">
            <!-- Separator between inactive tabs -->
            <div
              v-if="index > 0 && tab.id !== activeTabId && tabs[index - 1]?.id !== activeTabId"
              class="w-px h-4 bg-white/15 shrink-0 self-center"
            />
            <button
              class="flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors shrink-0"
              :class="[
                tab.id === activeTabId
                  ? 'bg-[#121212] rounded-t-[16px] relative -mb-px z-10'
                  : 'bg-transparent hover:bg-white/5',
              ]"
              :style="tab.id === activeTabId
                ? 'border: 1px solid rgba(255,255,255,0.06); border-bottom: none;'
                : 'border: none; border-radius: 0;'"
              @click="setActiveTab(tab.id)"
            >
            <!-- Tab icon / status -->
            <div class="flex items-center gap-2">
              <!-- Home tab: house icon -->
              <House v-if="tab.type === 'home'" class="size-4" :class="tab.id === activeTabId ? 'text-white' : 'text-white/50'" />
              <Globe v-else-if="tab.type === 'community'" class="size-4" :class="tab.id === activeTabId ? 'text-white' : 'text-white/50'" />
              <Image v-else-if="tab.type === 'assets'" class="size-4" :class="tab.id === activeTabId ? 'text-white' : 'text-white/50'" />
              <AppWindow v-else-if="tab.type === 'app'" class="size-4" :class="tab.id === activeTabId ? 'text-white' : 'text-white/50'" />
              <Wand v-else-if="tab.type === 'train'" class="size-4" :class="tab.id === activeTabId ? 'text-white' : 'text-white/50'" />
              <LayoutGrid v-else-if="tab.type === 'all-projects'" class="size-4" :class="tab.id === activeTabId ? 'text-white' : 'text-white/50'" />
              <Palette v-else-if="tab.type === 'brand'" class="size-4" :class="tab.id === activeTabId ? 'text-white' : 'text-white/50'" />
              <!-- Project tab: status indicator -->
              <template v-else>
                <!-- Idle: green dot -->
                <span
                  v-if="tab.status === 'idle' || !tab.status"
                  class="size-2.5 rounded-full bg-white"
                />
                <!-- Running: circular progress spinner -->
                <svg
                  v-else-if="tab.status === 'running'"
                  class="size-4"
                  viewBox="0 0 16 16"
                >
                  <circle
                    cx="8" cy="8" r="6"
                    fill="none"
                    stroke="#3f3f46"
                    stroke-width="2"
                  />
                  <circle
                    cx="8" cy="8" r="6"
                    fill="none"
                    stroke="var(--action)"
                    stroke-width="2"
                    stroke-linecap="round"
                    :stroke-dasharray="`${(tab.progress ?? 0) * 0.377} 37.7`"
                    transform="rotate(-90 8 8)"
                  />
                </svg>
                <!-- Done: green check -->
                <div
                  v-else-if="tab.status === 'done'"
                  class="size-4 rounded-full bg-[#4ade80] flex items-center justify-center"
                >
                  <Check class="size-2.5 text-black" :stroke-width="3" />
                </div>
              </template>
              <!-- Inline rename input -->
              <input
                v-if="editingTabId === tab.id"
                v-model="editingLabel"
                data-tab-rename-input
                class="text-xs font-medium text-white bg-white/10 rounded px-1 py-0.5 outline-none border border-white/20 w-[120px]"
                @blur="finishRenaming"
                @keydown.enter="finishRenaming"
                @keydown.escape="cancelRenaming"
                @click.stop
              />
              <!-- Normal label (double-click to rename) -->
              <span
                v-else
                class="text-xs font-medium text-white whitespace-nowrap max-w-[160px] truncate"
                :class="{ 'opacity-50': tab.id !== activeTabId }"
                @dblclick.stop="startRenaming(tab.id, tab.label)"
              >
                {{ tab.label }}
              </span>
              <!-- Status text: "Idle" or "76%" -->
              <template v-if="tab.type === 'project'">
                <span
                  v-if="tab.status === 'running'"
                  class="text-xs font-medium text-white/60"
                >
                  {{ tab.progress ?? 0 }}%
                </span>
                <span
                  v-else-if="tab.status === 'idle' || !tab.status"
                  class="text-xs font-medium text-white/40"
                >
                  Idle
                </span>
              </template>
            </div>
            <!-- Close button -->
            <X
              v-if="tab.closable"
              class="size-3.5 text-white/40 hover:text-white transition-opacity shrink-0"
              @click.stop="closeProjectTab(tab)"
            />
          </button>
          </template>

          <!-- Add tab button -->
          <button
            class="flex items-center justify-center size-8 mx-2 rounded-md text-white/40 hover:text-white hover:bg-white/5 transition-colors cursor-pointer shrink-0"
            @click="openTab({ type: 'project' })"
          >
            <Plus class="size-4" />
          </button>
        </div>

        <!-- Right side: credits + run + running count -->
        <div class="flex items-center gap-2 pr-4 shrink-0">
          <button
            class="flex items-center gap-1.5 bg-[#1a1a1a] rounded-full px-3 py-1.5 border border-[#2a2a2a] transition-colors"
            :class="hostedShell ? 'cursor-pointer hover:bg-[#222]' : 'cursor-default'"
            @click="onCreditsPillClick"
          >
            <span class="text-xs font-medium text-white/70">
              <template v-if="hostedShell && hostedWallet !== null">
                <RollingNumber :value="displayedWallet ?? hostedWallet" /> credits
              </template>
              <template v-else>{{ creditsPillText }}</template>
            </span>
          </button>
          <button
            class="flex items-center gap-1.5 bg-[#1a1a1a] rounded-full px-3 py-1.5 border border-[#2a2a2a] cursor-pointer hover:bg-[#222] transition-colors"
            @click="toggleQueue"
          >
            <Play class="size-3 text-white/70" />
            <span class="text-xs font-medium text-white/70">{{ runningCount }} running</span>
            <span
              v-if="activeTrainingCount"
              class="flex items-center gap-1 text-xs font-medium text-white/70 pl-1.5 ml-0.5 border-l border-[#2a2a2a]"
            >
              <span class="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {{ activeTrainingCount }} training
            </span>
          </button>
        </div>
      </div>

      <!-- Main content -->
      <main class="flex-1 overflow-auto bg-[#121212] border-t border-l border-[rgba(255,255,255,0.06)] relative">
        <!-- Opening-editor overlay: painted BEFORE the heavy Vue canvas mounts so
             the user gets feedback during the main-thread stall. The spinner uses a
             transform animation (compositor thread) so it keeps spinning while JS is
             blocked. Covers the whole main area (above the canvas/homepage). -->
        <div
          v-if="canvasOpening"
          class="absolute inset-0 z-40 bg-[#121212] flex flex-col items-center justify-center gap-3"
        >
          <div
            class="size-6 rounded-full border-2 border-white/10 border-t-white/50 animate-spin"
            style="will-change: transform"
          />
          <span class="text-xs text-white/40">Opening editor…</span>
        </div>
        <div v-show="activeTab.type === 'home'" class="h-full">
          <slot />
        </div>
        <!-- Assets history tab -->
        <div
          v-for="tab in tabs.filter((t) => t.type === 'assets')"
          :key="tab.id"
          v-show="tab.id === activeTabId"
          class="h-full"
        >
          <AssetsHistory />
        </div>
        <!-- Community (ComfyHub) tab -->
        <div
          v-for="tab in tabs.filter((t) => t.type === 'community')"
          :key="tab.id"
          v-show="tab.id === activeTabId"
          class="h-full overflow-auto"
        >
          <CommunityHome />
        </div>
        <!-- App tabs (single-purpose pages built on top of the same node engine) -->
        <div
          v-for="tab in tabs.filter((t) => t.type === 'app')"
          :key="tab.id"
          v-show="tab.id === activeTabId"
          class="h-full"
        >
          <AppsFaceSwapApp v-if="tab.appId === 'face-swap'" />
          <AppsAutoSubtitleApp v-else-if="tab.appId === 'auto-subtitle'" />
          <AppsKaraokeMakerApp v-else-if="tab.appId === 'karaoke-maker'" />
          <AppsProductShotApp v-else-if="tab.appId === 'product-shot'" />
        </div>
        <!-- Train LoRA tab -->
        <div
          v-for="tab in tabs.filter((t) => t.type === 'train')"
          :key="tab.id"
          v-show="tab.id === activeTabId"
          class="h-full"
        >
          <LoraTrainerSurface />
        </div>
        <!-- All projects tab (full grid of every project) -->
        <div
          v-for="tab in tabs.filter((t) => t.type === 'all-projects')"
          :key="tab.id"
          v-show="tab.id === activeTabId"
          class="h-full overflow-auto"
        >
          <AllProjectsView />
        </div>
        <!-- Brand page tab (app-wide kit library) -->
        <div
          v-for="tab in tabs.filter((t) => t.type === 'brand')"
          :key="tab.id"
          v-show="tab.id === activeTabId"
          class="h-full overflow-auto"
        >
          <BrandStudioPage />
        </div>
        <!-- Vue Node Canvas (when Modern node design enabled). canvasMountAllowed
             gates the FIRST mount so the opening overlay paints before this heavy
             component blocks the main thread. -->
        <div
          v-if="vueNodesEnabled && canvasMountAllowed && tabs.some((t) => t.type === 'project')"
          v-show="activeTab.type === 'project'"
          class="absolute inset-0 z-20"
        >
          <!-- Canvas area (always full-width) -->
          <div class="absolute inset-0">
            <VueCanvasVueNodeCanvas
              ref="vueCanvasRef"
              :workflow="activeTabWorkflow"
              :active-tool="activeTool"
              :active-worker="activeWorker"
              :displayed-canvas-id="activeProjectDoc?.activeCanvasId ?? null"
              :running-canvas-id="runningCanvasByWorker[activeWorker] ?? null"
            />
            <ExplainOverlay :vue-canvas="vueCanvasRef" />
          </div>
          <!-- Ready to deliver: pinned project view, swapped in over the
               canvas (see ProjectMenu's pinned entry / projectView ref). -->
          <VueCanvasDeliverablesPage
            v-if="activeTab.type === 'project' && projectView === 'deliverables'"
            class="absolute inset-0 z-30"
            :project-name="activeTab.label || 'Untitled project'"
            :api="deliverablesApi"
            @open-in-canvas="onOpenDeliverableInCanvas"
          />
          <!-- Read-only scrim when another window leads this project. Covers
               the canvas area only (tab bar stays clickable); the component
               renders nothing unless the role is 'follower'. -->
          <ProjectFollowerOverlay
            v-if="activeTab.type === 'project' && activeTab.projectUuid"
            :project-uuid="activeTab.projectUuid"
          />
          <!-- Native Nodes sidebar (overlays canvas from left) -->
          <Transition
            enter-active-class="transition-transform duration-300 ease-out"
            enter-from-class="-translate-x-full"
            enter-to-class="translate-x-0"
            leave-active-class="transition-transform duration-300 ease-in"
            leave-from-class="translate-x-0"
            leave-to-class="-translate-x-full"
          >
            <div v-if="vueNodesSidebarOpen" class="absolute top-0 left-0 bottom-0 w-[320px] z-30">
              <VueCanvasNodesSidebar @close="vueNodesSidebarOpen = false; activeSidebarItem = null" />
            </div>
          </Transition>
        </div>
        <!-- Workflow Overview right panel (overlays canvas) -->
        <Transition
          enter-active-class="transition-transform duration-300 ease-out"
          enter-from-class="translate-x-full"
          enter-to-class="translate-x-0"
          leave-active-class="transition-transform duration-300 ease-in"
          leave-from-class="translate-x-0"
          leave-to-class="translate-x-full"
        >
          <div v-if="vueRightPanelOpen" class="absolute top-0 right-0 bottom-0 w-[350px] z-30">
            <VueCanvasWorkflowOverview
              :nodes="vueCanvasRef?.getNodes?.() || []"
              @close="vueRightPanelOpen = false"
            />
          </div>
        </Transition>
        <!-- Node inspector right panel (overlays canvas, same slot as overview) -->
        <Transition
          enter-active-class="transition-transform duration-300 ease-out"
          enter-from-class="translate-x-full"
          enter-to-class="translate-x-0"
          leave-active-class="transition-transform duration-300 ease-in"
          leave-from-class="translate-x-0"
          leave-to-class="translate-x-full"
        >
          <div v-if="nodeInspectorOpen" class="absolute top-0 right-0 bottom-0 w-[350px] z-50">
            <VueCanvasNodeInspector
              :node="inspectorNode"
              @close="nodeInspectorOpen = false"
            />
          </div>
        </Transition>
        <!-- Toolbox left panel (overlays canvas) -->
        <Transition
          enter-active-class="transition-transform duration-300 ease-out"
          enter-from-class="-translate-x-full"
          enter-to-class="translate-x-0"
          leave-active-class="transition-transform duration-300 ease-in"
          leave-from-class="translate-x-0"
          leave-to-class="-translate-x-full"
        >
          <div v-if="toolboxPanelOpen" class="absolute top-0 left-0 bottom-0 w-[350px] z-40">
            <VueCanvasToolboxPanel @close="toolboxPanelOpen = false" />
          </div>
        </Transition>

        <!-- Generators left panel (mutually exclusive with Toolbox) -->
        <Transition
          enter-active-class="transition-transform duration-300 ease-out"
          enter-from-class="-translate-x-full"
          enter-to-class="translate-x-0"
          leave-active-class="transition-transform duration-300 ease-in"
          leave-from-class="translate-x-0"
          leave-to-class="-translate-x-full"
        >
          <div v-if="generatorsPanelOpen" class="absolute top-0 left-0 bottom-0 w-[350px] z-40">
            <VueCanvasGeneratorsPanel :focus-domain="actionsFocusDomain" @close="generatorsPanelOpen = false" />
          </div>
        </Transition>

        <!-- LoRA Library left panel (mutually exclusive with Toolbox/Generators) -->
        <Transition
          enter-active-class="transition-transform duration-300 ease-out"
          enter-from-class="-translate-x-full"
          enter-to-class="translate-x-0"
          leave-active-class="transition-transform duration-300 ease-in"
          leave-from-class="translate-x-0"
          leave-to-class="-translate-x-full"
        >
          <div v-if="loraLibraryPanelOpen" class="absolute top-0 left-0 bottom-0 w-[350px] z-40">
            <VueCanvasLoRALibraryPanel @close="loraLibraryPanelOpen = false" />
          </div>
        </Transition>

        <!-- Character Library left panel (mutually exclusive with the others) -->
        <Transition
          enter-active-class="transition-transform duration-300 ease-out"
          enter-from-class="-translate-x-full"
          enter-to-class="translate-x-0"
          leave-active-class="transition-transform duration-300 ease-in"
          leave-from-class="translate-x-0"
          leave-to-class="-translate-x-full"
        >
          <div v-if="charactersPanelOpen" class="absolute top-0 left-0 bottom-0 w-[350px] z-40">
            <VueCanvasCharacterRosterPanel @close="charactersPanelOpen = false" />
          </div>
        </Transition>

        <!-- Block Library left panel (mutually exclusive with the others) -->
        <Transition
          enter-active-class="transition-transform duration-300 ease-out"
          enter-from-class="-translate-x-full"
          enter-to-class="translate-x-0"
          leave-active-class="transition-transform duration-300 ease-in"
          leave-from-class="translate-x-0"
          leave-to-class="-translate-x-full"
        >
          <div v-if="blockLibraryPanelOpen" class="absolute top-0 left-0 bottom-0 w-[350px] z-40">
            <VueCanvasBlockLibraryPanel @close="blockLibraryPanelOpen = false" />
          </div>
        </Transition>

        <!-- Assets left panel (mutually exclusive with the others) -->
        <Transition
          enter-active-class="transition-transform duration-300 ease-out"
          enter-from-class="-translate-x-full"
          enter-to-class="translate-x-0"
          leave-active-class="transition-transform duration-300 ease-in"
          leave-from-class="translate-x-0"
          leave-to-class="-translate-x-full"
        >
          <div v-if="assetsPanelOpen" class="absolute top-0 left-0 bottom-0 w-[350px] z-40">
            <VueCanvasAssetsPanel @close="assetsPanelOpen = false" />
          </div>
        </Transition>

        <!-- Templates gallery left panel (mutually exclusive with the others) -->
        <Transition
          enter-active-class="transition-transform duration-300 ease-out"
          enter-from-class="-translate-x-full"
          enter-to-class="translate-x-0"
          leave-active-class="transition-transform duration-300 ease-in"
          leave-from-class="translate-x-0"
          leave-to-class="-translate-x-full"
        >
          <div v-if="templatesPanelOpen" class="absolute top-0 left-0 bottom-0 w-[350px] z-40">
            <VueCanvasTemplateLibraryPanel @close="templatesPanelOpen = false" />
          </div>
        </Transition>

        <!-- Project menu: floating chip at top-left — project name, canvas
             switcher, and version snapshots (replaces the Versions panel). -->
        <VueCanvasProjectMenu
          v-if="activeTab.type === 'project'"
          :project-id="activeTab.projectUuid || activeTab.workflowId || null"
          :project-name="activeTab.label || 'Untitled project'"
          :doc="activeProjectDoc"
          :switching="canvasSwitching"
          :get-project-doc="getProjectDocForVersionSave"
          :brand-kit-id="activeProjectDoc?.brandKitId ?? null"
          :brand-kit-name="brandKitName"
          :brand-swatches="brandSwatches"
          :deliverables-count="activeProjectDoc?.deliverables?.length ?? 0"
          @set-brand-kit="setBrandKit"
          @rename-project="renameActiveProject"
          @switch-canvas="switchProjectCanvas"
          @add-canvas="addProjectCanvas"
          @rename-canvas="renameProjectCanvas"
          @delete-canvas="deleteProjectCanvas"
          @restore="onRestoreVersion"
          @show-deliverables="showDeliverables"
        />

        <!-- Vue canvas top-right toolbar (Run / Stop / Panel) -->
        <div
          v-if="vueNodesEnabled && activeTab.type === 'project'"
          class="absolute top-3 right-3 flex items-center gap-1.5 z-40"
        >
          <button
            class="flex items-center gap-1.5 bg-action hover:bg-palette-blue/80 rounded-lg px-4 py-2 cursor-pointer transition-colors shadow-lg"
            @click="() => runVueWorkflow()"
          >
            <Play class="size-3.5 text-white fill-white" />
            <span class="text-sm font-semibold text-white">Run</span>
            <span v-if="runEstimate" class="text-[11px] font-medium text-white/75 tabular-nums">
              {{ formatEstimateBadge(runEstimate.usd, runEstimate.hostedCredits, true, hostedShell) }}
            </span>
          </button>
          <button
            class="flex items-center justify-center size-9 bg-[#1a1a1a]/90 rounded-lg border border-[#2a2a2a] cursor-pointer hover:bg-[#2a2a2a] transition-colors shadow-lg"
            title="Stop"
            @click="stopVueWorkflow"
          >
            <Square class="size-3.5 text-palette-coral fill-palette-coral" />
          </button>
          <div class="w-px h-5 bg-white/10" />
          <button
            class="flex items-center justify-center size-9 bg-[#1a1a1a]/90 rounded-lg border border-[#2a2a2a] cursor-pointer hover:bg-[#2a2a2a] transition-colors shadow-lg"
            :class="{ '!bg-[#2a2a2a] border-white/20': vueRightPanelOpen }"
            title="Toggle workflow overview"
            @click="toggleWorkflowOverview"
          >
            <PanelRight class="size-4 text-white/70" />
          </button>
        </div>

        <!-- Toast notifications (anchored below Run bar) -->
        <Sonner />

        <!-- LiteGraph iframe (worker 0 — loaded for execution; sidebar panels
             reused in Vue mode). Never in hosted mode: this is the engine
             origin, and it is the frame bridge.js posts from. -->
        <div
          v-if="!hostedShell && !directExecutionEnabled && tabs.some((t) => t.type === 'project')"
          v-show="(!vueNodesEnabled && activeTab.type === 'project') || (vueNodesEnabled && vueSidebarOpen)"
          data-tab-id="comfyui-shared"
          class="absolute inset-0 overflow-hidden z-30"
          :style="vueNodesEnabled && vueSidebarOpen ? { width: '320px', right: 'auto' } : {}"
        >
          <iframe
            :src="comfyIframeSrc"
            class="border-0 absolute"
            @load="onSharedIframeLoad"
            :style="{
              left: `-${COMFY_SIDEBAR_W}px`,
              top: `-${COMFY_TABBAR_H}px`,
              width: `calc(100% + ${COMFY_SIDEBAR_W}px)`,
              height: `calc(100% + ${COMFY_TABBAR_H}px)`,
            }"
          />
          <!-- Explain drag overlay -->
          <ExplainOverlay />
          <!-- Loading cover -->
          <Transition
            leave-active-class="transition-opacity duration-500 ease-out"
            leave-to-class="opacity-0"
          >
            <div
              v-if="backendBusy"
              class="absolute inset-0 z-30 bg-[#121212]"
            />
          </Transition>
        </div>

        <!-- Backdrop closes any open submenu popup on outside click. Sits below
             the toolbar (z-40) but above the canvas, so clicks pass through to
             the close handler instead of the canvas behind. -->
        <div
          v-if="openSubmenu && activeTab.type === 'project'"
          class="absolute inset-0 z-30"
          @click="openSubmenu = null"
        />
        <!-- Workflow status bar: replaces the start/complete/error toasts
             with one persistent surface for "what's the workflow doing."
             Skipped for silent live-runs (slider previews) so the bar
             doesn't flicker on every drag tick. -->
        <CanvasStatusBar
          v-if="activeTab.type === 'project'"
          :running="!!activeRunDisplay"
          :current-node="activeRunDisplay?.runningNode ?? ''"
          :progress="activeRunDisplay?.progress ?? { completed: 0, total: 0 }"
          :percent="activeRunDisplay?.percent ?? 0"
          :started-at="activeRunDisplay?.startedAt ?? null"
          :last-result="lastRunResult"
          :backend-busy="backendBusy"
          :backend-label="backendLabel"
          @stop="stopFromStatusBar"
          @dismiss-result="dismissRunResult"
        />

        <!-- Bottom-centre stack: the agent prompt sits above the toolbar and is
             sized to match it (the toolbar is the intrinsic-width child; the
             prompt is w-full). Only on project tabs. -->
        <!-- pointer-events: the stack overlays the canvas — the wrapper (and the
             gaps between its children) must not swallow canvas gestures; each
             child re-enables its own events (the prompt bar does so internally). -->
        <div
          v-if="activeTab.type === 'project'"
          data-testid="canvas-bottom-bar-stack"
          class="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-3"
        >
          <AgentCanvasPromptBar v-if="vueNodesEnabled" :vue-canvas="vueCanvasRef" class="w-0 min-w-full" />

          <!-- Floating toolbar -->
          <div
            class="pointer-events-auto flex items-center gap-1 bg-[#1a1a1a]/90 rounded-[12px] p-1 border border-[#2a2a2a] shadow-lg"
          >
          <template v-for="(item) in sidebarItems" :key="item.label">
            <div
              v-if="item.dividerBefore"
              class="w-px h-8 bg-white/10 mx-0.5"
            />
            <div class="relative">
              <button
                class="flex flex-col items-center gap-0.5 px-3 py-1 rounded-[8px] cursor-pointer transition-colors group"
                :class="isSidebarItemActive(item) ? 'bg-white/10' : 'hover:bg-white/5'"
                @click="toggleSidebarItem(item.label)"
              >
                <span class="relative">
                  <component :is="item.icon" class="size-4 text-white/70 group-hover:text-white transition-colors" :class="{ 'text-white': isSidebarItemActive(item) }" />
                  <span
                    v-if="item.pastel"
                    class="gen-pastel absolute -top-0.5 -right-1 size-1.5 rounded-full"
                    style="--gen-pastel: linear-gradient(90deg, rgba(255,214,231,.85), rgba(207,232,255,.85), rgba(214,255,224,.85), rgba(255,244,204,.85), rgba(231,214,255,.85), rgba(255,214,231,.85));"
                  />
                </span>
                <span class="text-[10px] text-white/50 group-hover:text-white/70 transition-colors" :class="{ 'text-white/80': isSidebarItemActive(item) }">
                  {{ item.label }}
                </span>
              </button>
              <!-- Popup anchored above the Load… button. Drops the matching
                   unified artifact node onto the canvas. -->
              <div
                v-if="item.submenu === 'load' && openSubmenu === 'load'"
                class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex flex-col gap-0.5 min-w-[160px] bg-[#1a1a1a]/95 border border-[#2a2a2a] rounded-[12px] p-1.5 shadow-xl whitespace-nowrap"
                @click.stop
              >
                <template v-for="(section, si) in loadSections" :key="section.label">
                  <div v-if="si > 0" class="h-px bg-white/10 mx-1 my-1" />
                  <p class="px-3 pt-0.5 pb-1 text-[9px] uppercase tracking-wider text-white/35">
                    {{ section.label }}
                  </p>
                  <button
                    v-for="opt in section.items"
                    :key="opt.label"
                    class="flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-left transition-colors"
                    :class="opt.disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-white/[0.08] cursor-pointer'"
                    :disabled="opt.disabled"
                    @click="!opt.disabled && onLoadOption(opt)"
                  >
                    <component :is="opt.icon" class="size-4 text-white/70" :stroke-width="1.75" />
                    <span class="text-xs text-white/85 flex-1">{{ opt.label }}</span>
                    <span v-if="opt.hint" class="text-[9px] uppercase tracking-wider text-white/35">{{ opt.hint }}</span>
                  </button>
                </template>
              </div>
              <!-- Studios door: craft places. Same popup shell as the Add menu. -->
              <div
                v-if="item.submenu === 'studios' && openSubmenu === 'studios'"
                class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex flex-col gap-0.5 min-w-[160px] bg-[#1a1a1a]/95 border border-[#2a2a2a] rounded-[12px] p-1.5 shadow-xl whitespace-nowrap"
                @click.stop
              >
                <button
                  v-for="opt in studiosOptions"
                  :key="opt.label"
                  class="flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-left transition-colors hover:bg-white/[0.08] cursor-pointer"
                  @click="onLoadOption(opt)"
                >
                  <component :is="opt.icon" class="size-4 text-white/70" :stroke-width="1.75" />
                  <span class="text-xs text-white/85 flex-1">{{ opt.label }}</span>
                  <span
                    v-if="opt.pastel"
                    class="gen-pastel size-1.5 rounded-full shrink-0"
                    style="--gen-pastel: linear-gradient(90deg, rgba(255,214,231,.85), rgba(207,232,255,.85), rgba(214,255,224,.85), rgba(255,244,204,.85), rgba(231,214,255,.85), rgba(255,214,231,.85));"
                    title="Uses AI credits"
                  />
                </button>
              </div>
              <!-- Generate door: curated zero-input AI verbs. Full catalog = Actions panel. -->
              <div
                v-if="item.submenu === 'generate' && openSubmenu === 'generate'"
                class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex flex-col gap-0.5 min-w-[160px] bg-[#1a1a1a]/95 border border-[#2a2a2a] rounded-[12px] p-1.5 shadow-xl whitespace-nowrap"
                @click.stop
              >
                <button
                  v-for="opt in generateOptions"
                  :key="opt.label"
                  class="flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-left transition-colors hover:bg-white/[0.08] cursor-pointer"
                  @click="addLoadNode(opt.nodeType)"
                >
                  <component :is="opt.icon" class="size-4 text-white/70" :stroke-width="1.75" />
                  <span class="text-xs text-white/85 flex-1">{{ opt.label }}</span>
                </button>
                <button
                  class="flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-left transition-colors hover:bg-white/[0.08] cursor-pointer"
                  @click.stop="generateAudioExpanded = !generateAudioExpanded"
                >
                  <AudioWaveform class="size-4 text-white/70" :stroke-width="1.75" />
                  <span class="text-xs text-white/85 flex-1">Audio</span>
                  <ChevronDown class="size-3 text-white/40 transition-transform" :class="generateAudioExpanded ? '' : '-rotate-90'" />
                </button>
                <template v-if="generateAudioExpanded">
                  <button
                    v-for="opt in generateAudioOptions"
                    :key="opt.label"
                    class="flex items-center gap-2 pl-8 pr-3 py-1.5 rounded-[8px] text-left transition-colors hover:bg-white/[0.08] cursor-pointer"
                    @click="addLoadNode(opt.nodeType)"
                  >
                    <component :is="opt.icon" class="size-3.5 text-white/60" :stroke-width="1.75" />
                    <span class="text-xs text-white/80 flex-1">{{ opt.label }}</span>
                  </button>
                </template>
              </div>
              <!-- "More" overflow popup: power-user actions (Nodes, Blocks) +
                   the annotate options, folded behind one toolbar item. -->
              <div
                v-if="item.submenu === 'more' && openSubmenu === 'more'"
                class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex flex-col gap-0.5 min-w-[180px] bg-[#1a1a1a]/95 border border-[#2a2a2a] rounded-[12px] p-1.5 shadow-xl whitespace-nowrap"
                @click.stop
              >
                <button
                  v-for="opt in moreOptions"
                  :key="opt.label"
                  class="flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-left transition-colors hover:bg-white/[0.08] cursor-pointer"
                  :class="isSidebarItemActive(opt) ? 'bg-white/10' : ''"
                  @click="runSidebarItem(opt)"
                >
                  <component :is="opt.icon" class="size-4 text-white/70" :stroke-width="1.75" />
                  <span class="text-xs text-white/85 flex-1">{{ opt.label }}</span>
                </button>
                <div class="h-px bg-white/10 mx-1 my-1" />
                <p class="px-3 pt-0.5 pb-1 flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-white/35">
                  <MessageSquareDashed class="size-3" /> Annotate
                </p>
                <button
                  v-for="opt in annotateOptions"
                  :key="opt.label"
                  class="flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-left transition-colors hover:bg-white/[0.08] cursor-pointer"
                  @click="addAnnotation(opt.kind)"
                >
                  <component :is="opt.icon" class="size-4 text-white/70" :stroke-width="1.75" />
                  <span class="text-xs text-white/85 flex-1">{{ opt.label }}</span>
                  <span v-if="opt.hint" class="text-[9px] uppercase tracking-wider text-white/40 bg-white/10 px-1.5 py-0.5 rounded">{{ opt.hint }}</span>
                </button>
              </div>
            </div>
          </template>
          </div>
        </div>
        <!-- Floating zoom/map toolbar (bottom-right, only on project tabs) -->
        <div
          v-if="activeTab.type === 'project'"
          class="absolute bottom-3 right-3 flex items-center gap-1 bg-[#1a1a1a]/90 rounded-[12px] p-1.5 border border-[#2a2a2a] shadow-lg z-50"
        >
          <button
            class="flex items-center justify-center size-8 rounded-[8px] cursor-pointer transition-colors group hover:bg-white/5"
            @click="zoomOut"
          >
            <ZoomOut class="size-4 text-white/70 group-hover:text-white transition-colors" />
          </button>
          <button
            class="flex items-center justify-center size-8 rounded-[8px] cursor-pointer transition-colors group hover:bg-white/5"
            @click="zoomReset"
          >
            <Maximize2 class="size-4 text-white/70 group-hover:text-white transition-colors" />
          </button>
          <button
            class="flex items-center justify-center size-8 rounded-[8px] cursor-pointer transition-colors group hover:bg-white/5"
            @click="zoomIn"
          >
            <ZoomIn class="size-4 text-white/70 group-hover:text-white transition-colors" />
          </button>
          <div class="w-px h-5 bg-white/10 mx-0.5" />
          <button
            class="flex items-center justify-center size-8 rounded-[8px] cursor-pointer transition-colors group"
            :class="minimapActive ? 'bg-white/10' : 'hover:bg-white/5'"
            @click="toggleMinimap"
          >
            <Map class="size-4 text-white/70 group-hover:text-white transition-colors" :class="{ 'text-white': minimapActive }" />
          </button>
        </div>
        <!-- Queue panel overlay -->
        <Transition
          enter-active-class="transition-all duration-200 ease-out"
          leave-active-class="transition-all duration-150 ease-in"
          enter-from-class="opacity-0 translate-y-2"
          leave-to-class="opacity-0 translate-y-2"
        >
          <div
            v-if="queueOpen"
            class="fixed right-4 top-14 w-[380px] max-h-[70vh] bg-[#1a1a1a] border border-[#2a2a2a] rounded-[12px] shadow-2xl z-[9999] flex flex-col overflow-hidden"
          >
            <!-- Header -->
            <div class="flex items-center justify-between px-4 py-3 border-b border-[#2a2a2a]">
              <span class="text-sm font-medium text-white">Queue</span>
              <button
                class="text-white/40 hover:text-white transition-colors cursor-pointer"
                @click="queueOpen = false"
              >
                <X class="size-4" />
              </button>
            </div>

            <!-- Content -->
            <div class="flex-1 overflow-y-auto">
              <!-- Trainings (cloud LoRA / voice) — server-side queue -->
              <div v-if="sortedTrainingJobs.length" class="px-4 pt-3 pb-1">
                <div class="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-2">Trainings</div>
                <div
                  v-for="job in sortedTrainingJobs"
                  :key="job.id"
                  class="bg-[#252525] rounded-lg p-3 mb-2"
                >
                  <div class="flex items-center gap-2 mb-1">
                    <span
                      class="size-2 rounded-full shrink-0"
                      :class="{
                        'bg-emerald-400 animate-pulse': job.status === 'starting' || job.status === 'processing',
                        'bg-white/20': job.status === 'queued',
                        'bg-emerald-400': job.status === 'succeeded',
                        'bg-red-400': job.status === 'failed',
                        'bg-white/15': job.status === 'canceled',
                      }"
                    />
                    <span class="text-xs font-medium text-white/90 truncate">{{ job.displayName }}</span>
                    <span class="text-[10px] uppercase tracking-wide text-white/30 shrink-0">{{ job.kind === 'voice' ? 'Voice' : (job.loraKind === 'character' ? 'Character' : 'Style') }}</span>
                    <span class="text-xs text-white/40 ml-auto shrink-0">{{ trainingStatusLabel(job) }}</span>
                    <button
                      v-if="job.status === 'queued' || job.status === 'starting' || job.status === 'processing'"
                      class="text-white/30 hover:text-white/80 transition-colors cursor-pointer shrink-0"
                      title="Cancel training"
                      @click="cancelTraining(job.id)"
                    >
                      <X class="size-3.5" />
                    </button>
                    <button
                      v-else
                      class="text-white/30 hover:text-white/80 transition-colors cursor-pointer shrink-0"
                      title="Dismiss"
                      @click="dismissTraining(job.id)"
                    >
                      <X class="size-3.5" />
                    </button>
                  </div>
                  <div v-if="job.status === 'failed' && job.error" class="text-[11px] text-red-400/80 mb-2 ml-4 line-clamp-2">{{ job.error }}</div>
                  <!-- Progress bar for in-flight jobs -->
                  <div
                    v-if="job.status === 'starting' || job.status === 'processing'"
                    class="h-1.5 bg-white/10 rounded-full overflow-hidden"
                  >
                    <div
                      v-if="job.progressPct > 0"
                      class="h-full bg-emerald-400 rounded-full transition-all duration-300"
                      :style="{ width: `${job.progressPct}%` }"
                    />
                    <div
                      v-else
                      class="h-full w-full rounded-full animate-queue-shimmer"
                      style="background: linear-gradient(90deg, transparent 0%, #34d399 50%, transparent 100%); background-size: 200% 100%;"
                    />
                  </div>
                </div>
              </div>

              <!-- Divider between trainings and the run queue -->
              <div v-if="sortedTrainingJobs.length && (queueData.running.length || queueData.pending.length || groupedHistory.length)" class="border-t border-[#2a2a2a] mx-4" />

              <!-- Running -->
              <div v-if="queueData.running.length" class="px-4 pt-3 pb-1">
                <div
                  v-for="(item, i) in queueData.running"
                  :key="`r-${i}`"
                  class="bg-[#252525] rounded-lg p-3 mb-2"
                >
                  <div class="flex items-center gap-2 mb-1">
                    <div class="size-2 rounded-full bg-action animate-pulse shrink-0" />
                    <span class="text-xs font-medium text-white/90 truncate">{{ runningWorkflowName(item[1]) }}</span>
                    <span class="text-xs text-white/40 ml-auto shrink-0">{{ queueItemProgress(item[1]) }}%</span>
                  </div>
                  <div v-if="promptNodeInfo[item[1]]?.nodeType || activeRunDisplay?.runningNode" class="text-[11px] text-white/40 mb-2 ml-4 truncate">
                    {{ promptNodeInfo[item[1]]?.nodeType || activeRunDisplay?.runningNode }}
                  </div>
                  <!-- Progress bar -->
                  <div class="h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div
                      v-if="queueItemProgress(item[1]) > 0"
                      class="h-full bg-action rounded-full transition-all duration-300"
                      :style="{ width: `${queueItemProgress(item[1])}%` }"
                    />
                    <div
                      v-else
                      class="h-full w-full rounded-full animate-queue-shimmer"
                      style="background: linear-gradient(90deg, transparent 0%, var(--action) 50%, transparent 100%); background-size: 200% 100%;"
                    />
                  </div>
                </div>
              </div>

              <!-- Pending -->
              <div v-if="queueData.pending.length" class="px-4 pt-2 pb-1">
                <div
                  v-for="(item, i) in queueData.pending"
                  :key="`p-${i}`"
                  class="flex items-center gap-2 py-2 px-3 bg-[#252525] rounded-lg mb-2"
                >
                  <div class="size-2 rounded-full bg-white/20 shrink-0" />
                  <span class="text-xs text-white/50 truncate">Pending</span>
                </div>
              </div>

              <!-- Divider between queue and history -->
              <div v-if="(queueData.running.length || queueData.pending.length) && groupedHistory.length" class="border-t border-[#2a2a2a] mx-4" />

              <!-- History -->
              <div v-if="groupedHistory.length" class="px-4 pt-2 pb-3">
                <div v-for="group in groupedHistory" :key="group.label" class="mb-3 last:mb-0">
                  <div class="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-2">{{ group.label }}</div>
                  <div
                    v-for="item in group.items"
                    :key="item.promptId"
                    class="flex items-center gap-3 py-2 rounded-lg"
                  >
                    <!-- Thumbnail or status icon -->
                    <div v-if="item.status === 'failed'" class="size-10 rounded-lg bg-red-500/10 flex items-center justify-center shrink-0">
                      <AlertCircle class="size-4 text-red-400" />
                    </div>
                    <img
                      v-else-if="item.images.length"
                      :src="thumbnailUrl(item.images[0])"
                      class="size-10 rounded-lg object-cover bg-[#252525] shrink-0"
                      loading="lazy"
                    />
                    <div v-else class="size-10 rounded-lg bg-[#252525] shrink-0" />

                    <!-- Info -->
                    <div class="flex-1 min-w-0">
                      <div v-if="item.status === 'failed'" class="text-xs font-medium text-red-400">Failed</div>
                      <div v-else-if="item.images.length" class="text-xs text-white/80 truncate">{{ item.images[0].filename }}</div>
                      <div v-else class="text-xs text-white/50 truncate">No output</div>
                      <div class="text-[11px] text-white/30 mt-0.5">
                        <template v-if="item.status === 'failed'">Failed</template>
                        <template v-else-if="item.executionTime !== null">{{ formatDuration(item.executionTime) }}</template>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Empty state -->
              <div
                v-if="!queueData.running.length && !queueData.pending.length && !groupedHistory.length && !sortedTrainingJobs.length"
                class="flex flex-col items-center justify-center py-8 text-center"
              >
                <Play class="size-8 text-white/20 mb-2" />
                <span class="text-sm text-white/40">No items in queue</span>
                <span class="text-xs text-white/25 mt-1">Run a workflow to see it here</span>
              </div>
            </div>
          </div>
        </Transition>

        <!-- Explain panel -->
        <ExplainPanel />
      </main>
    </div>

    <!-- Node search dialog (Space key) -->
    <NodeSearchDialog />

    <!-- "Get Started" modal: shows once per fresh blank project. Pre-builds
         a runnable graph from the user's intent (output × input × model). -->
    <StartProjectModal
      v-if="startModalTabId && activeTabId === startModalTabId"
      @start="onStartModalPick"
      @studio="onStartModalStudio"
      @skip="onStartModalSkip"
    />

    <!-- Private-beta gate: overlays everything (fixed inset-0 z-[200]) when
         the wallet fetch reports a signed-in, non-invited account. -->
    <BetaGate v-if="betaGated" />
  </div>
</template>

<style scoped>
/* Tab strip scrolls horizontally when tabs overflow, instead of spilling over
   the credits/run controls. Hide the scrollbar to keep the bar clean. */
.tab-strip {
  scrollbar-width: none;
}
.tab-strip::-webkit-scrollbar {
  display: none;
}
</style>
