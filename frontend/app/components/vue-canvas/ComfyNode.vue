<script setup lang="ts">
import { Boxes, ChevronDown, ChevronLeft, ChevronRight, Download, Frame, Layers, Loader2, Lock, LockOpen, Play, Sparkles, SkipBack, SkipForward, SlidersHorizontal, Upload, RefreshCw } from 'lucide-vue-next'
import { getTypeColor, getInputTooltip } from '~/composables/useVueNodes'
import { useAgentActivity } from '~/composables/useAgentActivity'
import { useDirectExecutionEnabled } from '~/composables/useDirectExecutionEnabled'
import { getPartnerIcon } from '~/lib/partnerIcons'
import { promptFirst } from '~/lib/canvas/widgetOrder'
import { nodeTier } from '~/lib/canvas/nodeTier'
import { minHeightForPorts } from '~/lib/canvas/portLayout'
import { useNodePortSync } from '~/composables/useNodePortSync'
import NodeCapsule from '~/components/vue-canvas/NodeCapsule.vue'
import { resolveReadout } from '~/lib/canvas/capsuleReadout'
import { resolveNodeIcon, type NodeIcon } from '~/lib/canvas/nodeIcon'
import { readoutRuleFor, defaultCollapsed } from '~/lib/canvas/capsuleMeta'
import { isLoraSlotWidgetVisible } from '~/lib/graph/loraSlotVisibility'
import { loraSlotResetPlan, moodboardSlotKey } from '~/lib/graph/loraStyleBlocks'
import { clearMoodboardFromGenerateNode, revertMoodboardSwitch } from '~/lib/graph/moodboardApply'
// By path, not auto-import — Nuxt collapses duplicated path segments and an
// unresolved name renders NOTHING, silently (see WidgetLoraPicker's note).
import WidgetMoodboardChip from '~/components/vue-canvas/widgets/WidgetMoodboardChip.vue'
import type { CapsuleAction, CapsuleState } from '~/lib/canvas/capsuleAction'
import { LIVE_PREVIEW_NODE_TYPES } from '~/lib/livePreviewNodes'
import { allowedAspectRatios, allowedDurations, modelSupportsSeed } from '~/lib/videoModelAdapt'
import { TOOLBOX_NODE_ICONS } from '~/data/toolbox-items'
import { getGeneratorIcon } from '~/data/generator-icons'
import { hostedModeEnabled } from '~/lib/hostedMode'
import { creditsForUsd } from '~/lib/pricing'
import { MODEL_PRICED_BADGE_CLASSES, nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import TakesStrip from '~/components/vue-canvas/TakesStrip.vue'
import LightTableModal from '~/components/vue-canvas/LightTableModal.vue'
import { projectTake, discardOthers, type Take } from '~/composables/useTakes'
import { annotatedImageValueFromViewUrl } from '~/lib/promoteTempImages'
import { toast } from 'vue-sonner'

const props = defineProps<{
  id: string
  data: {
    nodeType: string
    title: string
    category?: string
    outputNode?: boolean
    priceBadge?: { expr: string; depends_on?: any[] } | null
    inputs: { name: string; type: string; link: number | null }[]
    outputs: { name: string; type: string; links: number[] | null }[]
    widgetsValues: any[]
    widgetDefs?: any[]
    properties: Record<string, any>
    mode: number
    color?: string
    bgcolor?: string
    size?: [number, number]
    running?: boolean
    runningSince?: number | null
    hasRun?: boolean
    collapsed?: boolean
    error?: boolean
    progress?: number
    images?: string[]
    audios?: string[]
    animated?: boolean
    errorMessage?: string | null
    // Takes (non-destructive variation loop) — flag-gated, additive.
    takes?: Take[]
    activeTakeId?: string | null
    // Subgraph metadata
    isSubgraph?: boolean
    subgraphName?: string | null
    subgraphId?: string | null
    innerNodeCount?: number
  }
}>()

const isVideo = computed(() => {
  if (props.data.animated) return true
  // LoadVideo / LoadVideoFrames always render as a video player.
  if (props.data.nodeType === 'LoadVideo' || props.data.nodeType === 'LoadVideoFrames') return true
  // Also detect by file extension in the URL — check both execution output
  // and the displayed list so synthetic preview URLs (e.g. /view?...mp4)
  // trigger the <video> branch too.
  const src = props.data.images?.[0] || displayedImages.value[0]
  if (!src) return false
  return /\.(mp4|webm|mov|avi|mkv)/i.test(src)
})

const accentColor = computed(() => {
  const firstOutput = props.data.outputs?.[0]
  if (firstOutput) return getTypeColor(firstOutput.type)
  const firstInput = props.data.inputs?.[0]
  if (firstInput) return getTypeColor(firstInput.type)
  return '#6b7280'
})

// Border glow colors for running animation — reflects input/output type colors
const borderColorLeft = computed(() => {
  const firstInput = props.data.inputs?.[0]
  return firstInput ? getTypeColor(firstInput.type) : '#ffffff'
})
const borderColorRight = computed(() => {
  const firstOutput = props.data.outputs?.[0]
  return firstOutput ? getTypeColor(firstOutput.type) : '#ffffff'
})

const partnerIconUrl = computed(() => getPartnerIcon(props.data.category || ''))

// Toolbox icon: surfaces the Lucide icon defined in the Toolbox catalog
// (data/toolbox-items.ts) in the node's title bar when neither a subgraph
// icon nor a partner icon takes precedence. Falls through to nothing when
// the node type isn't a toolbox item.
const toolboxIcon = computed(() => TOOLBOX_NODE_ICONS[props.data.nodeType as string] || null)

// Per-generator-node icon (Generate=Sparkles, Upscale=Maximize, …). Takes
// precedence over the provider's partner logo so the title bar reflects
// what the node does, not just who runs it.
const generatorIcon = computed(() => getGeneratorIcon(props.data.nodeType as string))

// Frontend overrides for node title-bar names. The backend display_name (e.g.
// "Flux Dev + LoRA (Replicate)") describes the model; here we relabel a node in
// terms of what the user is doing with it. Per CLAUDE.md, UI naming lives in Vue.
const NODE_TITLE_OVERRIDES: Record<string, string> = {
  FluxLoRARemoteNode: 'Generate an image with a style',
  FluxMultiLoRARemoteNode: 'Mix styles together',
  LayerizeGraphicNode: 'Separate text from image',
  SplitPhotoLayersNode: 'Separate background and foreground',
}
const displayTitle = computed(
  () => NODE_TITLE_OVERRIDES[props.data.nodeType as string] || props.data.title,
)

// Cost badge. Local mode shows the operator's own provider spend in dollars;
// hosted mode shows credits, because that is what a hosted user pays in.
const hostedBadges = hostedModeEnabled(useRuntimeConfig().public)

// The MODEL a picker node is currently set to. Read reactively off
// widgetsValues so switching models in the gallery re-prices the badge.
const pricedModelValue = computed(() => {
  if (!MODEL_PRICED_BADGE_CLASSES.has(props.data.nodeType as string)) return null
  const idx = widgetIndex('model')
  return idx >= 0 ? props.data.widgetsValues?.[idx] : null
})

// Extract the minimum USD price from the price badge expression
const priceLabel = computed(() => {
  // Model-priced pickers: the static badge is a fiction — GenerateVideoNode
  // ships ONE badge figure while its model widget spans an 8× price range. In
  // hosted mode quote what the server will actually charge for the model that
  // is selected right now (same catalogs + markup as server/utils/priceBook).
  if (hostedBadges) {
    const est = nodeCreditEstimate(props.data.nodeType as string, pricedModelValue.value)
    if (est != null) return `~${est} cr`
    // Unknown/missing model → fall through to the static estimate below.
  }
  const badge = props.data.priceBadge
  if (!badge?.expr) return null
  // Extract all decimal numbers from the expression (prices are typically 0.01-10.0 range)
  const numbers = badge.expr.match(/\d+\.\d+/g)
  if (!numbers?.length) return hostedBadges ? '~? cr' : '~$?'
  const prices = numbers.map(Number).filter(n => n > 0 && n < 100)
  if (!prices.length) return hostedBadges ? '~? cr' : '~$?'
  const min = Math.min(...prices)
  if (hostedBadges) return `~${creditsForUsd(min)} cr`
  // Format: $0.07, $0.12, $1.50
  return min < 0.01 ? '<$0.01' : `~$${min.toFixed(2)}`
})

const isMuted = computed(() => props.data.mode === 2)
const isBypassed = computed(() => props.data.mode === 4)

// Per-node Run button surfaces on:
//   1. Generator nodes (costly API calls — Replicate, BFL, OpenAI, …).
//   2. Output nodes (anything OUTPUT_NODE=True in Python — PreviewImage,
//      SaveImage, etc.). Treats the click as "run to here" since these are
//      already valid sinks, sidestepping ComfyUI's "Prompt has no outputs"
//      rejection.
//   3. Slow local compute that takes seconds to minutes — same iteration
//      value as a generator, just on-device. Curated allowlist below.
//
// Skipped on purpose: live-preview nodes (they auto-run), Load nodes (no
// execution), Note / Subgraph IO (no execution).
const HEAVY_LOCAL_COMPUTE = new Set<string>([
  'FaceSwap', 'FaceRestore', 'LipSync', 'ObjectRemove',
  'SubjectMask', 'MaskExtractor',
])

const showRunButton = computed(() => {
  const t = props.data.nodeType
  if (HEAVY_LOCAL_COMPUTE.has(t)) return true
  // OUTPUT_NODE=True covers real sinks (SaveImage, PreviewImage…) but also
  // every local image-adjust node that ships a UI preview (Blur, Sharpen,
  // AdjustCurves, …) — those already auto-run via the live-preview pipeline,
  // so suppress the button there.
  if (props.data.outputNode && !LIVE_PREVIEW_NODES.has(t)) return true
  return (props.data.category || '').startsWith('api node/')
})

// --- Per-node run control (footer split button) ---------------------------
// One primary action — run THIS node, upstream cached — that reads as "Play"
// before the first run and "Re-render" after. A caret opens the two scope
// variants. All three dispatch the same `sailor:runFiltered` event the old
// two buttons did; only the `detail` differs.
const runMenuOpen = ref(false)
const runMenuRoot = ref<HTMLElement | null>(null)
// Optimistic "has been played": flips on the first run click so the label
// switches to Re-render immediately, OR derives from an existing result so a
// reloaded graph that already produced output reads correctly.
const playedOnce = ref(false)
const hasRun = computed(() =>
  playedOnce.value
  || !!(props.data.images?.length || props.data.audios?.length
        || (props.data as any).text || props.data.takes?.length),
)

function dispatchRun(detail: Record<string, any>) {
  if (isMuted.value || isBypassed.value || props.data.running) return
  playedOnce.value = true
  runMenuOpen.value = false
  window.dispatchEvent(new CustomEvent('sailor:runFiltered', {
    detail: { targetIds: [props.id], ...detail },
  }))
}
// Primary: re-roll ONLY this node — upstream stays cached (ComfyUI cache-hits
// it, no regen/re-billing), just this node + its preview recompute.
function playThisNode() { dispatchRun({ rerollScope: 'self' }) }
// Variant (direct-execution only): re-roll THIS node 4× in parallel across the
// cloud pool — four fresh-seeded takes at once. Same 'self' scope + event; the
// `takes` count flows through runVueWorkflow → queueParallel at the dispatch
// site. Gated on the direct flag because the parallel pool is a direct-only path.
const { directExecutionEnabled } = useDirectExecutionEnabled()
function rerollTakesParallel() { dispatchRun({ rerollScope: 'self', takes: 4 }) }
// Variant: fresh run of everything before this node, new seeds throughout.
function runFromStart() { dispatchRun({}) }
// Variant: push this node's current result through everything downstream.
function runDownstream() { dispatchRun({ direction: 'downstream' }) }
// Ask the agent to LOOK at this result and suggest fixes (run→look→fix, on-demand).
function critiqueResult() {
  runMenuOpen.value = false
  window.dispatchEvent(new CustomEvent('sailor:critiqueNode', { detail: { nodeId: props.id } }))
}
// The agent is reviewing THIS node → show the white scanning overlay.
const { analyzingNodeIds } = useAgentActivity()
const isAnalyzing = computed(() => analyzingNodeIds.value.has(props.id))

function onRunMenuDocPointer(e: MouseEvent) {
  if (runMenuRoot.value && !runMenuRoot.value.contains(e.target as Node)) runMenuOpen.value = false
}
watch(runMenuOpen, (open) => {
  if (open) document.addEventListener('mousedown', onRunMenuDocPointer)
  else document.removeEventListener('mousedown', onRunMenuDocPointer)
})
onUnmounted(() => document.removeEventListener('mousedown', onRunMenuDocPointer))

// --- Capsule (collapsed resting state) ------------------------------------
// A node is a capsule when it has been explicitly collapsed, or when its type
// says so by default and nobody has said otherwise. `collapsed` is tri-state
// on purpose: undefined means "use the tier default", so changing a default
// later still reaches nodes saved before the change.
const isCapsule = computed(() => {
  if (typeof props.data.collapsed === 'boolean') return props.data.collapsed
  // Use the `hasRun` computed above, not `data.hasRun`. The computed already
  // derives from an existing result, so a graph that produced output before
  // this feature existed still collapses; `data.hasRun` is only ever stamped by
  // a completion event, which meant no pre-existing canvas ever showed a
  // capsule. Keep `data.hasRun` in the OR for node types whose output is not
  // images/audio/text/takes.
  return defaultCollapsed('comfy', hasRun.value || Boolean(props.data.hasRun))
})

// Ticks only while this node is running, so an idle canvas does no work.
const nowTick = ref(Date.now())
let tickId: ReturnType<typeof setInterval> | null = null
watch(() => props.data.running, (running) => {
  if (tickId) { clearInterval(tickId); tickId = null }
  if (running) tickId = setInterval(() => { nowTick.value = Date.now() }, 1000)
}, { immediate: true })
onBeforeUnmount(() => { if (tickId) clearInterval(tickId) })

const capsuleReadout = computed(() => resolveReadout({
  rule: readoutRuleFor(props.data.nodeType as string),
  widgetDefs: props.data.widgetDefs,
  widgetsValues: props.data.widgetsValues,
  properties: props.data.properties,
  running: props.data.running,
  runningSince: props.data.runningSince,
  // Gated on `error`, exactly as the expanded card's error chip is (:1460).
  // errorMessage is a sticky field — it holds the last exception text until
  // something overwrites it — so passing it ungated would pin a dead failure
  // to the read-out for the rest of the session, outranking both "rendering ·
  // 12s" and the settings summary on every subsequent run.
  errorMessage: props.data.error ? props.data.errorMessage : null,
  now: nowTick.value,
}))

// resolveNodeIcon only knows {nodeType, category} — subgraphs render a
// dedicated icon in the expanded card's title bar (the three-box glyph just
// below), so special-case them here rather than widen the shared resolver.
const hasHeaderIcon = computed(() =>
  Boolean(props.data.isSubgraph || generatorIcon.value || partnerIconUrl.value || toolboxIcon.value),
)

// Ticker for a truncated card title. Measured on hover rather than watched: the
// title only changes when the node does, and a ResizeObserver per node on a
// canvas of forty is a cost for something nobody looks at until they hover it.
// The card GROWS into place. Earlier attempts animated clip-path, which looks
// similar but is not: clip does not affect layout, so the node occupied its
// full height from the first frame, the ports jumped to their final positions
// instantly and the edges snapped. Animating real height is what makes the
// wires follow, because the ports are positioned off the node's own box.
//
// Height is measured and set inline. It cannot be done in CSS (there is no
// height to animate to) and it cannot be measured in `before-enter`, which
// fires before layout and reports 0.
//
// The measured target can be short of the final height when the card's content
// (images, canvases) is still settling. That is survivable rather than a bug:
// `transition-property: height` stays on the element for the whole duration, so
// the later growth animates on the same curve instead of snapping.
//
// Width is not animated because there is nothing to animate: the capsule is
// given the same width as the card it stands in for, so expanding changes
// height only. That is also why the header can stay put — nothing moves
// horizontally at any point in the transition.
// The height the card grows FROM. Captured off the real capsule at the moment
// it is dismissed rather than hardcoded — a capsule with a read-out and one
// without are different heights, and hardcoding meant the grow started from the
// wrong place for one of them.
let lastCapsuleH = 44

function beginGrow(node: HTMLElement, from: number, to: number) {
  node.style.overflow = 'hidden'
  node.style.height = `${from}px`
  void node.offsetHeight // commit the start height before changing it
  node.style.height = `${to}px`
}

function onUnfoldEnter(el: Element) {
  const node = el as HTMLElement
  // offsetHeight, not getBoundingClientRect: the latter is multiplied by the
  // canvas viewport's zoom, which would make the target height wrong on any
  // canvas not at 100%.
  const full = node.offsetHeight
  if (full <= lastCapsuleH) return
  beginGrow(node, lastCapsuleH, full)
}

function onFoldLeave(el: Element) {
  const node = el as HTMLElement
  const full = node.offsetHeight
  if (full <= lastCapsuleH) return
  beginGrow(node, full, lastCapsuleH)
}

function clearUnfold(el: Element) {
  const node = el as HTMLElement
  node.style.height = ''
  node.style.overflow = ''
}

const titleClipEl = ref<HTMLElement | null>(null)
function measureTitle() {
  const clip = titleClipEl.value
  const track = clip?.firstElementChild as HTMLElement | undefined
  if (!clip || !track) return
  const dist = track.scrollWidth - clip.clientWidth
  const overflows = dist > 1
  clip.style.setProperty('--tick-shift', overflows ? `-${dist}px` : '0px')
  // ~30px/s plus a beat at each end, so long titles do not race past.
  clip.style.setProperty('--tick-dur', overflows ? `${Math.max(2.4, dist / 30 + 1.4)}s` : '0s')
}

const capsuleIcon = computed<NodeIcon>(() => {
  if (props.data.isSubgraph) return { kind: 'component', value: Boxes }
  return resolveNodeIcon({
    nodeType: props.data.nodeType as string,
    category: props.data.category,
  })
})

const capsuleState = computed<CapsuleState>(() => {
  if (props.data.error) return 'failed'
  if (props.data.running) return 'running'
  return props.data.hasRun ? 'done' : 'ready'
})

// The capsule's button reports WHICH action its label promised (see
// lib/canvas/capsuleAction.ts); this only routes it. Note `run` cannot go
// through dispatchRun's guard-free twin — dispatchRun returns early while
// running, which is exactly why the stop button used to do nothing.
function onCapsuleAction(action: CapsuleAction) {
  if (action === 'run') { playThisNode(); return }
  if (action === 'expand') { onExpandCapsule(); return }
  // Interrupt. The real implementation is stopVueWorkflow() in the layout —
  // the same one the canvas toolbar's stop button calls — so this dispatches
  // to it rather than growing a second /interrupt caller. It is queue-wide,
  // not node-scoped, which matches what the toolbar button already does.
  window.dispatchEvent(new CustomEvent('sailor:stopRun', { detail: { nodeId: props.id } }))
}

// --- Expand / re-collapse -------------------------------------------------
// The spec's interaction model: "a click on the capsule body opens the full
// card, pinned until you click away". Nothing used to unpin it, so a capsule
// opened once stayed open forever. `pinnedOpen` holds the card open and arms
// the click-away listener.
const pinnedOpen = ref(false)

function onExpandCapsule() {
  const el = portSyncRoot.value?.querySelector('.node-capsule') as HTMLElement | null
  if (el) lastCapsuleH = el.offsetHeight
  props.data.collapsed = false
  pinnedOpen.value = true
}

function collapseBack() {
  pinnedOpen.value = false
  // Back to the TIER DEFAULT, not a hard `true`. `collapsed` is tri-state:
  // undefined means "ask the tier", so a node whose default is expanded (not
  // yet run) correctly stays open when you click away from it, and a node
  // whose default is a capsule settles back into one.
  props.data.collapsed = undefined
}

function onPinnedDocPointer(e: MouseEvent) {
  const root = portSyncRoot.value
  if (root && root.contains(e.target as Node)) return
  // Only a click on the canvas surface counts as "away". A click into a modal
  // this node opened (Light Table, the inspector, a toolbar) is still working
  // on this node, and collapsing it out from under the user would be hostile.
  if (!(e.target as HTMLElement)?.closest?.('.vue-flow')) return
  collapseBack()
}
function onPinnedKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') collapseBack()
}
watch(pinnedOpen, (pinned) => {
  if (pinned) {
    document.addEventListener('mousedown', onPinnedDocPointer)
    document.addEventListener('keydown', onPinnedKeydown)
  }
  else {
    document.removeEventListener('mousedown', onPinnedDocPointer)
    document.removeEventListener('keydown', onPinnedKeydown)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onPinnedDocPointer)
  document.removeEventListener('keydown', onPinnedKeydown)
})

// --- Takes (non-destructive variation loop) -------------------------------
// The strip renders once there's at least one take. Actions mutate props.data
// in place (same pattern as widget edits) — projectTake mirrors the chosen take
// onto images/audios/text so the preview updates.
function selectTake(id: string) {
  const t = (props.data.takes || []).find((x) => x.id === id)
  if (t) Object.assign(props.data, projectTake(props.data, t))
}
function pinTake(id: string) {
  const t = (props.data.takes || []).find((x) => x.id === id)
  if (t) t.pinned = !t.pinned
  // Phase 3: persist pinned takes to the asset library with provenance.
}
function discardTake(id: string) {
  const takes = (props.data.takes || []).filter((x) => x.id !== id)
  props.data.takes = takes
  if (props.data.activeTakeId === id) {
    // Fall back to a pinned take if there is one, else the most recent.
    const fallback = takes.find((t) => t.pinned) || takes[takes.length - 1] || null
    Object.assign(props.data, projectTake(props.data, fallback))
  }
}

// Light Table: takes land on this generator card, so the compare modal is
// hosted here (not in ArtifactImageNode). The strip's expand button opens it.
const lightTableOpen = ref(false)

// Write a new takes array + re-project the active take. Mirrors discardTake's
// mutation but takes an explicit active id (used by discard-others + its undo).
function setTakes(takes: Take[], activeId: string | null) {
  props.data.takes = takes
  const active = takes.find((t) => t.id === activeId) || takes.find((t) => t.pinned) || takes[takes.length - 1] || null
  Object.assign(props.data, projectTake(props.data, active))
}
function onDiscardOthers(keepId: string) {
  const before = [...(props.data.takes ?? [])]
  const beforeActiveId = props.data.activeTakeId ?? null
  const kept = discardOthers(before, keepId)
  if (kept.length === before.length) return
  setTakes(kept, keepId)
  const n = before.length - kept.length
  toast(`Discarded ${n} take${n === 1 ? '' : 's'}`, {
    action: { label: 'Undo', onClick: () => setTakes(before, beforeActiveId) },
  })
}
function branchFromTake(takeId: string) {
  const take = (props.data.takes ?? []).find((t) => t.id === takeId)
  const url = take?.images?.[0]
  if (!take || !url) return
  const imageWidgetValue = annotatedImageValueFromViewUrl(url)
  window.dispatchEvent(new CustomEvent('sailor:addNode', {
    detail: {
      nodeType: 'Image',
      dataOverrides: { images: [url], takes: [{ ...take, pinned: true }], activeTakeId: take.id },
      ...(imageWidgetValue ? { widgetOverrides: { image: imageWidgetValue } } : {}),
    },
  }))
  lightTableOpen.value = false
}

// Live-preview node types: auto-run on widget change (debounced) so the
// preview image refreshes without the user clicking Run. Shared with the
// take-capture exclusion in VueNodeCanvas — see lib/livePreviewNodes.ts.
const LIVE_PREVIEW_NODES = LIVE_PREVIEW_NODE_TYPES

// Video nodes: hide the seed widget (and its hidden control companion) when
// the selected model's API takes no seed (registry flag supportsSeed — e.g.
// Kling v2.5 Turbo Pro 422s on it). Visibility is render-only; the positional
// widgets_values slots are untouched, so alignment is safe.
const videoSeedGate = (name: string, values: any[], defs: any[]): boolean => {
  if (name !== 'seed' && name !== 'seed_control') return true
  const modelIdx = defs.findIndex((d: any) => d?.name === 'model')
  if (modelIdx < 0) return true
  return modelSupportsSeed(String(values[modelIdx] ?? ''))
}

// Per-node conditional widget visibility. Return true to show the widget,
// false to hide it based on another widget's current value.
const WIDGET_VISIBILITY: Record<string, (widgetName: string, values: any[], defs: any[]) => boolean> = {
  Blur: (name, values, defs) => {
    if (name === 'type') return true
    const typeIdx = defs.findIndex(d => d.name === 'type')
    const type = values[typeIdx]
    if (type === 'gaussian') return name === 'radius'
    if (type === 'motion') return name === 'angle' || name === 'length'
    if (type === 'zoom') return name === 'strength'
    return true
  },
  Fractal: (name, values, defs) => {
    const typeIdx = defs.findIndex(d => d.name === 'type')
    const type = values[typeIdx]
    // Hide the Julia-only seed params when in mandelbrot mode.
    if (type === 'mandelbrot' && (name === 'julia_cx' || name === 'julia_cy')) return false
    return true
  },
  // The points widget is a JSON blob managed by clicking on the preview;
  // we hide it so users don't accidentally edit raw JSON.
  MaskExtractor: (name) => name !== 'points',

  // Lens · 3D Reframe: the source/target lens pickers are the focal-length strips
  // (rendered separately in the node body), so hide the raw dropdowns. custom_focal
  // is orphaned without a Custom chip, so hide it too — only reframe_strength shows.
  LensReframe: (name) =>
    name !== 'source_lens' && name !== 'target_lens' && name !== 'custom_focal',
  // ASCII: hide everything from the node body — all controls live in the
  // "More options" right panel.
  Ascii: () => false,

  // SmartLayout: the raw widgets (layout JSON, aspects CSV, brand key=value)
  // are designer-hostile. The node body renders friendly format chips + an
  // Edit-layout button instead (SmartLayoutNodeBody); brand lives in the
  // project brand kit + the editor's Brand panel + the wiring socket.
  SmartLayout: () => false,

  // Video generation nodes: hide the seed/seed_control widgets when the
  // selected model's API takes no seed parameter (registry flag supportsSeed).
  // Model-specific advanced settings live in the ModelGalleryModal bag, so the
  // node body only shows shared widgets (model, prompt, aspect_ratio, seed).
  GenerateVideoNode: videoSeedGate,
  FilmShotNode: videoSeedGate,
  // Upscalers expose very different controls per engine — Clarity has the full
  // diffusion knob set, Real-ESRGAN/Topaz just face-enhance + scale, Recraft
  // Crisp takes nothing but the image. Gate them so the node only shows what
  // the selected model actually uses.
  UpscaleImageNode: (name, values, defs) => isVisibleForModel('UpscaleImageNode', name, values, defs),
  // Enhance Detail: Creative = diffusion path (prompt+seed+resemblance+steps);
  // Faithful = Topaz controls; Diffusion Refine = SUPIR knobs.
  EnhanceDetailNode: (name, values, defs) => isVisibleForModel('EnhanceDetailNode', name, values, defs),
  // Outpaint: Flux Fill uses a direction picker; Bria Expand uses an aspect
  // ratio. Show only the control the selected engine actually consumes.
  OutpaintImageNode: (name, values, defs) => isVisibleForModel('OutpaintImageNode', name, values, defs),
  // Flux + LoRAs: four slots, but C and D stay hidden until the immediately
  // preceding slot is filled — a fresh node reads as the two-slot node it replaced.
  // Slot A only browses characters, so style-only users can chain B → C → D.
  // Properties ride along because a moodboard-held slot has NO widget value
  // ('[None]' picker, blank url) — only `properties.sailor_moodboard_<letter>`
  // says it's occupied, and without it a moodboard in B never reveals C.
  FluxMultiLoRARemoteNode: (name, values, defs) => isLoraSlotWidgetVisible(name, values, defs, props.data.properties),
}

// Sibling of WIDGET_VISIBILITY: per-node option FILTERS for combo widgets.
// A rule returns the allowed values for a widget (null = leave schema options
// alone). The filtered list is intersected with the schema options and falls
// back to the schema when the intersection is empty — we never invent values
// the backend combo would reject.
const videoOptionsFilter = (name: string, values: any[], defs: any[]): string[] | null => {
  if (name !== 'duration' && name !== 'aspect_ratio') return null
  const modelIdx = defs.findIndex((d: any) => d?.name === 'model')
  if (modelIdx < 0) return null
  const id = String(values[modelIdx] ?? '')
  return name === 'duration' ? allowedDurations(id) : allowedAspectRatios(id)
}

const WIDGET_OPTIONS: Record<string, (name: string, values: any[], defs: any[]) => string[] | null> = {
  GenerateVideoNode: videoOptionsFilter,
  FilmShotNode: videoOptionsFilter,
}

// For each use-case node, map model-gated widget names → the Model combo value
// they belong to. If a widget appears here and the current model doesn't
// match, the widget is hidden. Widgets NOT in this map are always visible
// (the shared inputs at the top of each node).
const MODEL_GATED_WIDGETS: Record<string, Record<string, string | string[]>> = {
  // GenerateImageNode and GenerateVideoNode entries removed — their advanced
  // settings live in the ModelGalleryModal (per-model bag) instead of as
  // gated widgets on the node. Video seed gating is handled by videoSeedGate.
  // Upscale engines. `model` is ungated (always shown). Recraft Crisp takes
  // only the image, so none of these match it → it shows just the model picker.
  UpscaleImageNode: {
    prompt:                 'Clarity',
    scale_factor:           ['Clarity', 'Crystal', 'Real-ESRGAN'],   // Topaz uses topaz_upscale_factor; Recraft takes none
    creativity:             'Clarity',
    resemblance:            'Clarity',
    negative_prompt:        'Clarity',
    num_inference_steps:    'Clarity',
    seed:                   'Clarity',
    face_enhance:           ['Real-ESRGAN', 'Topaz'],
    // Topaz-only controls (topazlabs/image-upscale)
    topaz_enhance_model:    'Topaz',
    topaz_upscale_factor:   'Topaz',
    topaz_subject_detection:'Topaz',
    topaz_output_format:    'Topaz',
    topaz_face_creativity:  'Topaz',
    topaz_face_strength:    'Topaz',
    // Crystal-only controls (philz1337x/crystal-upscaler)
    crystal_creativity:     'Crystal',
    crystal_output_format:  'Crystal',
  },
  // Enhance Detail engines. `image`, `model`, and `detail_strength` are always
  // visible. Creative = Clarity; Faithful = Topaz; Diffusion Refine = Magic Refiner.
  EnhanceDetailNode: {
    prompt:                  ['Creative', 'Diffusion Refine'],
    resemblance:             'Creative',
    negative_prompt:         'Creative',
    num_inference_steps:     'Creative',
    seed:                    ['Creative', 'Diffusion Refine'],
    topaz_enhance_model:     'Faithful',
    topaz_subject_detection: 'Faithful',
    topaz_output_format:     'Faithful',
    refine_steps:            'Diffusion Refine',
  },
  OutpaintImageNode: {
    direction:    'Flux Fill',     // directional / zoom-out picker
    aspect_ratio: 'Bria Expand',   // target canvas ratio
  },
}

function isVisibleForModel(nodeType: string, widgetName: string, values: any[], defs: any[]): boolean {
  const gates = MODEL_GATED_WIDGETS[nodeType]
  if (!gates) return true
  const gate = gates[widgetName]
  if (!gate) return true              // not gated → always show
  const modelIdx = defs.findIndex(d => d.name === 'model')
  if (modelIdx < 0) return true       // no model combo found → don't hide
  const currentModel = values[modelIdx]
  const allowed = Array.isArray(gate) ? gate : [gate]
  return allowed.includes(currentModel)
}

function isWidgetVisible(widget: any): boolean {
  const rule = WIDGET_VISIBILITY[props.data.nodeType]
  if (!rule) return true
  return rule(widget.name, props.data.widgetsValues || [], props.data.widgetDefs || [])
}

// The widget def handed to ComfyNodeWidget — the original, or a shallow clone
// with filtered options. node.data.widgetDefs is NEVER mutated.
function effectiveWidgetDef(widget: any): any {
  const rule = WIDGET_OPTIONS[props.data.nodeType]
  if (!rule) return widget
  const allowed = rule(widget.name, props.data.widgetsValues || [], props.data.widgetDefs || [])
  if (!allowed) return widget
  const schema: string[] = Array.isArray(widget.options) ? widget.options : []
  const filtered = schema.filter((o: any) => allowed.includes(String(o)))
  if (filtered.length === 0 || filtered.length === schema.length) return widget
  return { ...widget, options: filtered }
}

// Per-node widget groupings. Widgets in a group render together under a
// collapsible header. Widgets not listed render flat above the groups.
const WIDGET_GROUPS: Record<string, { title: string; widgets: string[] }[]> = {
  // Keep the node tidy: only prompt / LoRA / scale / aspect ratio show by
  // default; the rest live in a collapsed Advanced group.
  FluxLoRARemoteNode: [
    { title: 'Advanced', widgets: ['lora_url', 'megapixels', 'num_inference_steps', 'guidance', 'seed', 'prompt_strength'] },
  ],
  AdjustColorBalance: [
    { title: 'Shadows',    widgets: ['shadows_cr',    'shadows_mg',    'shadows_yb'] },
    { title: 'Midtones',   widgets: ['midtones_cr',   'midtones_mg',   'midtones_yb'] },
    { title: 'Highlights', widgets: ['highlights_cr', 'highlights_mg', 'highlights_yb'] },
  ],
  AdjustChannelMixer: [
    { title: 'Red output',   widgets: ['r_from_r', 'r_from_g', 'r_from_b'] },
    { title: 'Green output', widgets: ['g_from_r', 'g_from_g', 'g_from_b'] },
    { title: 'Blue output',  widgets: ['b_from_r', 'b_from_g', 'b_from_b'] },
  ],
  // Compositor: 16 optional layer slots. Per-layer widgets stay grouped/
  // collapsible — everything above layer 1 starts collapsed so the panel
  // doesn't explode when none of them are connected.
  Compositor: Array.from({ length: 16 }, (_, i) => i + 1).map((i) => ({
    title: `Layer ${i}`,
    widgets: [
      `layer${i}_x`, `layer${i}_y`, `layer${i}_rotation`,
      `layer${i}_scale`, `layer${i}_opacity`, `layer${i}_blend`,
    ],
  })),
}

// Initial collapsed state — keep every Compositor layer beyond #1 collapsed
// so a fresh node isn't a wall of accordion groups.
const collapsedGroups = ref(new Set<string>([
  'Advanced',
  'Midtones', 'Highlights', 'Green output', 'Blue output',
  ...Array.from({ length: 15 }, (_, i) => `Layer ${i + 2}`),
]))

// Visual tier: content-carrying nodes dominate, pass-through utilities recede.
// Drives port placement, width and opacity so a reroute stops competing with a
// generator for attention.
const tier = computed(() => nodeTier(props.data.nodeType))
const isRecessiveNode = computed(() => tier.value === 'recessive')

// Centred ports move whenever the node's height changes, so Vue Flow's cached
// handle geometry has to be refreshed or edges stay pinned to stale positions.
const portSyncRoot = ref<HTMLElement | null>(null)
useNodePortSync(portSyncRoot)

// "Grow as you connect" node types — the canvas shows only the slots in use
// plus one trailing empty slot ready to catch the next connection. The Python
// schema declares a generous static cap (Compositor: 16, SmartLayout: 8);
// this is purely a UI affordance to keep the node tidy.
const DYNAMIC_GROW_NODES = new Set<string>(['Compositor', 'SmartLayout', 'Timeline', 'GenerateImageNode', 'EditImageNode'])

// Model-gated reference ports: GenerateImageNode / EditImageNode declare
// image_N inputs in their Python schema, but only some models can use them.
// Keep these sets in sync with _IMAGE_GEN_REF_MODELS / _MULTI_IMAGE_EDIT_MODELS
// in nodes_replicate.py.
const MULTI_REF_MODELS: Record<string, Set<string>> = {
  GenerateImageNode: new Set(['nano-banana-2', 'nano-banana-pro']),
  EditImageNode: new Set(['Nano Banana 2', 'Nano Banana Pro', 'Flux 2 Pro']),
}

// Vue Flow's edges array, provided by the canvas. Needed here (and not just
// further down where the upstream-image helper uses it) because the dynamic-
// grow + live-preview logic below reads the live connection state straight
// from edges. Declared early to avoid TDZ when reactive watchers fire.
const injectedNodes = inject<any>('vueFlowNodes', null)
const injectedEdges = inject<any>('vueFlowEdges', null)

// Which input port indices to actually render. For most nodes that's
// every index 0..N-1. For dynamic-grow nodes only the connected ones plus
// one trailing empty slot are visible — SmartLayout has *two* such groups
// (image_layer_* and text_layer_*) that grow independently, so we work in
// terms of an index set rather than a count.
const visibleInputIndices = computed<number[]>(() => {
  const inputs = (props.data.inputs ?? []) as { name?: string; link?: number | null }[]
  const all = inputs.map((_, i) => i)
  if (!DYNAMIC_GROW_NODES.has(props.data.nodeType)) return all

  // Build the set of connected input indices for THIS node from live Vue Flow
  // edges. Vue Flow's `onConnect` only appends to `edges` — it never writes
  // back to `inputs[i].link`, so the previous check (which relied on `.link`)
  // never saw new connections. Reading edges directly fixes that.
  const connectedIdxs = new Set<number>()
  const liveEdges = (injectedEdges?.value ?? []) as Array<{ target?: string; targetHandle?: string | null }>
  for (const e of liveEdges) {
    if (e.target !== props.id) continue
    const m = /^input-(\d+)$/.exec(e.targetHandle ?? '')
    if (m) connectedIdxs.add(parseInt(m[1]!, 10))
  }
  // Also count anything the serialized state already records as connected
  // (e.g. when a workflow is freshly loaded — edges exist alongside the
  // .link field, both should imply "connected").
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i]?.link != null) connectedIdxs.add(i)
  }

  // Helper: of the indices in `groupIdxs`, keep "connected so far + 1 empty
  // catcher" — at least 1 slot, capped at the group's full length.
  const visibleInGroup = (groupIdxs: number[]) => {
    if (groupIdxs.length === 0) return []
    let highest = -1
    for (let p = 0; p < groupIdxs.length; p++) {
      if (connectedIdxs.has(groupIdxs[p]!)) highest = p
    }
    const showCount = Math.max(1, Math.min(groupIdxs.length, highest + 2))
    return groupIdxs.slice(0, showCount)
  }

  const refModels = MULTI_REF_MODELS[props.data.nodeType]
  if (refModels) {
    // Reference ports (image_N) are gated on the selected model: hidden for
    // models that can't use them (except already-connected ones, so their
    // wires stay reachable for disconnecting), grow-as-you-connect otherwise.
    const refIdxs = all.filter((i) => /^image_\d+$/.test(inputs[i]?.name ?? ''))
    const restIdxs = all.filter((i) => !/^image_\d+$/.test(inputs[i]?.name ?? ''))
    const model = String(props.data.widgetsValues?.[widgetIndex('model')] ?? '')
    const visibleRefs = refModels.has(model)
      ? visibleInGroup(refIdxs)
      : refIdxs.filter((i) => connectedIdxs.has(i))
    return [...restIdxs, ...visibleRefs].sort((a, b) => a - b)
  }

  if (props.data.nodeType === 'SmartLayout') {
    // Two independent grow groups + non-grow inputs (brand) always visible.
    const imageIdxs = all.filter((i) => inputs[i]?.name?.startsWith('image_layer_'))
    const textIdxs  = all.filter((i) => inputs[i]?.name?.startsWith('text_layer_'))
    const nonGrowIdxs = all.filter((i) => {
      const n = inputs[i]?.name ?? ''
      return !n.startsWith('image_layer_') && !n.startsWith('text_layer_')
    })
    return [...nonGrowIdxs, ...visibleInGroup(imageIdxs), ...visibleInGroup(textIdxs)]
      .sort((a, b) => a - b)
  }

  // Compositor: single grow group covering all inputs.
  return visibleInGroup(all)
})

// Resolved input slots for the port loop. Pairing each index with its slot here
// keeps the template from indexing into a possibly-sparse array.
const visiblePorts = computed(() =>
  visibleInputIndices.value
    .map(idx => ({ idx, slot: props.data.inputs[idx] }))
    .filter((p): p is { idx: number; slot: NonNullable<typeof p.slot> } => !!p.slot),
)

// Ports are absolutely positioned, so a short node with many of them would let
// the last dots hang past its bottom edge. Floor the node's height instead.
const portsMinHeight = computed(() =>
  minHeightForPorts(Math.max(visibleInputIndices.value.length, props.data.outputs.length)),
)

// The grouped widgets to actually render. For Compositor the layer index
// embedded in the title ("Layer 3") is matched against the highest visible
// layer slot so transform controls only show for layers that currently have
// a port. We derive that ceiling from visibleInputIndices to stay in sync.
const visibleWidgetGroups = computed(() => {
  const groups = WIDGET_GROUPS[props.data.nodeType] || []
  if (props.data.nodeType !== 'Compositor') return groups
  const max = visibleInputIndices.value.length
  return groups.filter((g) => {
    const m = /^Layer (\d+)$/.exec(g.title)
    return !m || Number(m[1]) <= max
  })
})
function toggleGroup(title: string) {
  const next = new Set(collapsedGroups.value)
  if (next.has(title)) next.delete(title)
  else next.add(title)
  collapsedGroups.value = next
}

const groupedWidgetNames = computed(() => {
  const groups = WIDGET_GROUPS[props.data.nodeType]
  if (!groups) return new Set<string>()
  return new Set(groups.flatMap(g => g.widgets))
})

function widgetIndex(name: string): number {
  return (props.data.widgetDefs || []).findIndex((d: any) => d.name === name)
}

// Seed widget lock-state read/write. Two storage paths depending on whether
// the widget follows Comfy's control_after_generate convention:
//   - Standard (KSampler etc.): widgets_values[i+1] holds "fixed"/"randomize"
//   - Non-standard (Replicate, custom): node.properties.seedLocks[name] = bool
// Treat the two uniformly from the widget's perspective via a single bool.
function isSeedWidgetDef(widget: any): boolean {
  if (!widget || widget.type !== 'INT') return false
  if (widget.control_after_generate) return true
  return /seed/i.test(String(widget.name || ''))
}
function isSeedFixed(widget: any, i: number): boolean {
  if (!isSeedWidgetDef(widget)) return false
  if (widget.control_after_generate) {
    return props.data.widgetsValues?.[i + 1] === 'fixed'
  }
  return !!(props.data.properties as any)?.seedLocks?.[widget.name]
}
function setSeedFixed(widget: any, i: number, fixed: boolean) {
  if (!isSeedWidgetDef(widget)) return
  if (widget.control_after_generate) {
    if (!props.data.widgetsValues) return
    props.data.widgetsValues[i + 1] = fixed ? 'fixed' : 'randomize'
    return
  }
  if (!props.data.properties) (props.data as any).properties = {}
  const locks = ((props.data.properties as any).seedLocks ??= {})
  locks[widget.name] = fixed
}

// Node-level seed lock: a title-bar toggle that fixes every seed on the node so
// re-runs keep the same options (the pre-Run randomizer skips fixed seeds). Reads
// and writes the same per-seed state the inspector's seed widget toggles.
const seedWidgets = computed(() =>
  ((props.data.widgetDefs || []) as any[])
    .map((widget, index) => ({ widget, index }))
    .filter(({ widget }) => isSeedWidgetDef(widget)))
const hasSeed = computed(() => seedWidgets.value.length > 0)
const seedLocked = computed(() =>
  hasSeed.value && seedWidgets.value.every(({ widget, index }) => isSeedFixed(widget, index)))
function toggleSeedLock() {
  const next = !seedLocked.value
  for (const { widget, index } of seedWidgets.value) setSeedFixed(widget, index, next)
}

function widgetsInGroup(title: string): any[] {
  const groups = WIDGET_GROUPS[props.data.nodeType]
  if (!groups) return []
  const g = groups.find(gr => gr.title === title)
  if (!g) return []
  const byName = new Map((props.data.widgetDefs || []).map((d: any) => [d.name, d]))
  return g.widgets.map(n => byName.get(n)).filter(Boolean)
}

// FluxLoRARemoteNode/FluxMultiLoRARemoteNode carry a schema-free "Style"/aesthetic
// field (a node PROPERTY folded into the prompt at submit, not a ComfyUI input).
// It now lives in the NodeInspector; this flag gates the per-node settings button.
const isLoraStyleNode = computed(() =>
  props.data.nodeType === 'FluxLoRARemoteNode' || props.data.nodeType === 'FluxMultiLoRARemoteNode')
// Inputs flagged `advanced` in the node schema collapse into an "Advanced"
// section (closed by default) so a node shows only its core controls. Honors
// the same hidden/internal/grouped exclusions as the main widget loop.
const advancedOpen = ref(false)
// Advanced widgets that still render on the node. Inspector-bound widgets
// (which includes everything `advanced`) are relocated to the NodeInspector, so
// in practice this is empty and the node's "Advanced" disclosure auto-hides —
// kept as a filter (not a hard `[]`) so the predicate stays the single source.
const advancedWidgets = computed(() =>
  (props.data.widgetDefs || []).filter((w: any) =>
    w.advanced && !w.hidden && w.sailor_widget !== 'internal'
    && isWidgetVisible(w) && !groupedWidgetNames.value.has(w.name)
    && !isInspectorWidgetDef(w)))

/**
 * The body's widget order: prompts first, everything else as declared. Some generators
 * put a model picker or a size combo above the prompt, which buries the one control the
 * node exists for. `promptFirst` carries each widget's ORIGINAL index because
 * `widgetsValues` is positional — sorting the definitions alone would read every value
 * from the wrong slot, and that fails silently rather than visibly.
 */
const orderedWidgets = computed(() => promptFirst(props.data.widgetDefs as any[]))

// Fold each LoRA strength slider INTO its picker card. A `lora_picker` widget
// pairs with a scale widget by name: lora_a→scale_a, lora_b→scale_b,
// lora_name→lora_scale. We render the slider inside the card (see WidgetLoraPicker)
// and skip the standalone scale widget in the loops below so it doesn't render twice.
function scaleNameForPicker(name: string): string {
  return name === 'lora_name' ? 'lora_scale' : name.replace(/^lora_/, 'scale_')
}
const loraScaleByPicker = computed(() => {
  const defs = (props.data.widgetDefs || []) as any[]
  const map = new Map<string, { name: string; index: number; def: any }>()
  for (const w of defs) {
    if (w?.sailor_widget !== 'lora_picker') continue
    const sn = scaleNameForPicker(w.name)
    const idx = defs.findIndex((d: any) => d?.name === sn)
    if (idx >= 0) map.set(w.name, { name: sn, index: idx, def: defs[idx] })
  }
  return map
})
const foldedScaleNames = computed(() =>
  new Set([...loraScaleByPicker.value.values()].map((v) => v.name)))

// A slot holding a MOODBOARD (weightless — moodboards plan 2026-08-06, Task A7)
// is identified purely by properties.sailor_moodboard_<letter>. The picker card
// then shows the board's name/thumb and must NOT show a strength row: there are
// no weights to scale. We suppress by returning no scaleDef for that picker
// (hasScale keys off scaleMax in WidgetLoraPicker) while foldedScaleNames STILL
// contains the scale widget — dropping it from the fold would resurrect the
// standalone scale_<letter> slider below the card, which is worse.
function moodboardIdForPicker(pickerName: string): string | null {
  const key = moodboardSlotKey(pickerName)
  const v = key ? props.data.properties?.[key] : null
  return typeof v === 'string' && v.trim() !== '' ? v : null
}
// GenerateImageNode's moodboard chip (moodboards Plan B, Task B2). NODE-FACE
// row rather than a sailor_widget-driven ComfyNodeWidget: the backing
// style_block/style_refs inputs must stay `sailor_widget: "internal"` (hidden
// — the widget loop filters them), and the chip's state is node PROPERTIES
// (`sailor_moodboard` + `aesthetic`), not a widget value. Picking goes through
// the LoRA gallery with kind 'moodboard' and the style_block sentinel target.
const generateMoodboardId = computed<string | null>(() => {
  if (props.data.nodeType !== 'GenerateImageNode'
      && props.data.nodeType !== 'RestyleFromImageNode') return null
  const v = props.data.properties?.sailor_moodboard
  return typeof v === 'string' && v.trim() !== '' ? v : null
})
function openGenerateMoodboardGallery() {
  window.dispatchEvent(new CustomEvent('sailor:openLoraGallery', {
    detail: { nodeId: props.id, widgetName: 'style_block', kind: 'moodboard' },
  }))
}
function clearGenerateMoodboard() {
  clearMoodboardFromGenerateNode(props.data)
  // Applying IS wiring: the ✕ also removes the TASTE edge into this node's
  // style_in (the Moodboard node itself STAYS on canvas). Edge removal is
  // canvas-owned — VueNodeCanvas handles this event.
  window.dispatchEvent(new CustomEvent('sailor:moodboardUnwire', {
    detail: { nodeId: props.id },
  }))
}
// Task B3: refs badge + auto-switch notice state, both plain node properties
// written by applyMoodboardToGenerateNode.
const generateMoodboardHasRefs = computed<boolean>(() => {
  const v = props.data.properties?.style_refs
  return typeof v === 'string' && v.trim() !== ''
})
const generateMoodboardSwitchedFrom = computed<string | null>(() => {
  const v = props.data.properties?.sailor_moodboard_switched
  return typeof v === 'string' && v.trim() !== '' ? v : null
})
// One-click Revert on the auto-switch notice: the pure helper clears the
// marker + refs and hands back the model to restore; the positional widget
// writes (model + its options mirror) stay here where widgetDefs live.
function revertGenerateMoodboardSwitch() {
  const prev = revertMoodboardSwitch(props.data)
  if (!prev) return
  const mIdx = widgetIndex('model')
  if (mIdx >= 0 && props.data.widgetsValues) props.data.widgetsValues[mIdx] = prev
  const optsIdx = widgetIndex('model_options')
  if (optsIdx >= 0 && props.data.widgetsValues) {
    props.data.widgetsValues[optsIdx] = JSON.stringify(
      (props.data.properties as any)?.modelOptions?.[prev] ?? {},
    )
  }
}

function loraScaleDef(pickerName: string): any {
  if (moodboardIdForPicker(pickerName)) return undefined
  return loraScaleByPicker.value.get(pickerName)?.def
}
function loraScaleValue(pickerName: string): number | undefined {
  if (moodboardIdForPicker(pickerName)) return undefined
  const idx = loraScaleByPicker.value.get(pickerName)?.index ?? -1
  return idx >= 0 ? (props.data.widgetsValues?.[idx] as number) : undefined
}
function setLoraScale(pickerName: string, val: number) {
  const idx = loraScaleByPicker.value.get(pickerName)?.index ?? -1
  if (idx >= 0) props.data.widgetsValues[idx] = val
}

// Clear (×) affordance on a filled picker card. Fully resets the slot so a
// cleared LoRA stops loading (and stops costing money on every run): the
// picker itself, its URL-override sibling (the node prefers the URL over the
// filename, so a stale override would silently keep the slot alive), its
// scale sibling (reset to the SCHEMA default — read off widgetDefs, never
// hardcoded here, so this can't drift from the Python default), and its
// style-block property (invisible in the UI; leaving it would keep steering
// the prompt for a LoRA that's no longer loaded).
//
// Deliberately NOT done here: stripping a cleared CHARACTER's trigger word
// out of the `prompt` widget. Characters put their trigger directly into the
// visible prompt box, where the user can see and edit it themselves — unlike
// the hidden style block, leaving it is a visible, editable no-op, not a
// silent leftover, so this asymmetry is a decision, not an oversight.
function clearLoraSlot(pickerName: string) {
  const plan = loraSlotResetPlan(pickerName)
  const defs = (props.data.widgetDefs || []) as any[]
  const values = props.data.widgetsValues

  const pickerIdx = defs.findIndex((d) => d?.name === plan.picker)
  if (pickerIdx >= 0) values[pickerIdx] = '[None]'

  const urlIdx = defs.findIndex((d) => d?.name === plan.url)
  if (urlIdx >= 0) values[urlIdx] = ''

  const scaleIdx = defs.findIndex((d) => d?.name === plan.scale)
  if (scaleIdx >= 0) values[scaleIdx] = defs[scaleIdx]?.default

  // slotAestheticKey (and so loraSlotResetPlan.aestheticKey) returns null for
  // 'lora_name' because that node has no per-letter slot key — but it still
  // has a style block, just the plain `properties.aesthetic` field (see
  // loraStyleBlocks.ts's module doc). So: per-slot key when there is one,
  // else fall back to plain 'aesthetic' for the single-LoRA node specifically
  // (not for any other null-aestheticKey case, which shouldn't reach here).
  const aestheticKey = plan.aestheticKey ?? (plan.picker === 'lora_name' ? 'aesthetic' : null)
  if (aestheticKey && props.data.properties) {
    delete props.data.properties[aestheticKey]
  }

  // A moodboard-held slot stores its identity here (the widgets above are
  // already '[None]'/blank for it) — leaving it would keep the card face, the
  // aesthetic-less slot-filled state, and slot C's visibility all alive.
  if (plan.moodboardKey && props.data.properties) {
    delete props.data.properties[plan.moodboardKey]
  }
}

// "Mechanical" widgets that live in the NodeInspector (seed / aspect_ratio /
// advanced). The title-bar settings button shows only when the node has some,
// and opens the inspector for this node. Mirror NodeInspector.isInspectorWidget.
function isInspectorWidgetDef(w: any): boolean {
  if (!w || w.hidden || w.sailor_widget === 'internal' || w.sailor_widget === 'lora_picker') return false
  if (w.advanced) return true
  if (w.type === 'INT' && (w.control_after_generate || /seed/i.test(String(w.name || '')))) return true
  if (w.name === 'aspect_ratio') return true
  return false
}
const hasInspectorSettings = computed(() =>
  isLoraStyleNode.value || ((props.data.widgetDefs || []) as any[]).some(isInspectorWidgetDef))
function openInspector() {
  window.dispatchEvent(new CustomEvent('sailor:openInspector', { detail: { nodeId: props.id } }))
}

const isLivePreview = computed(() => LIVE_PREVIEW_NODES.has(props.data.nodeType))

let liveRunTimer: ReturnType<typeof setTimeout> | null = null

// Build a fresh "is input N connected?" snapshot from edges + .link fallback,
// so live-preview connection-change watching sees Vue Flow wires (which only
// update edges, never `inputs[i].link`).
function connectionFingerprint(): string {
  const inputs = (props.data.inputs ?? []) as any[]
  const connected = new Set<number>()
  const liveEdges = (injectedEdges?.value ?? []) as Array<{ target?: string; targetHandle?: string | null }>
  for (const e of liveEdges) {
    if (e.target !== props.id) continue
    const m = /^input-(\d+)$/.exec(e.targetHandle ?? '')
    if (m) connected.add(parseInt(m[1]!, 10))
  }
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i]?.link != null) connected.add(i)
  }
  return inputs.map((_, i) => connected.has(i) ? '1' : '0').join('')
}

function scheduleLiveRun() {
  if (!isLivePreview.value) return
  // Skip if any *required* input port is unconnected — server would error.
  // Optional inputs are fine to leave dangling. Same edge-aware check as
  // connectionFingerprint above.
  const inputs = (props.data.inputs ?? []) as any[]
  const connected = new Set<number>()
  const liveEdges = (injectedEdges?.value ?? []) as Array<{ target?: string; targetHandle?: string | null }>
  for (const e of liveEdges) {
    if (e.target !== props.id) continue
    const m = /^input-(\d+)$/.exec(e.targetHandle ?? '')
    if (m) connected.add(parseInt(m[1]!, 10))
  }
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i]?.link != null) connected.add(i)
  }
  if (inputs.some((inp: any, i: number) => !inp.optional && !connected.has(i))) return

  if (liveRunTimer) clearTimeout(liveRunTimer)
  liveRunTimer = setTimeout(() => {
    // Carry the node id so the handler can run JUST this node (+ upstream
    // keep-set, which cache-hits when unchanged). An id-less liveRun used to
    // fall through to runVueWorkflow(undefined) — a FULL-graph run, so merely
    // wiring an input into a live-preview node re-executed the entire canvas.
    window.dispatchEvent(new CustomEvent('sailor:liveRun', { detail: { nodeId: props.id } }))
  }, 150)
}
// JSON-stringifying the watch source so Vue compares with `===` instead of
// chasing reactive references. Without this, `executed` event updates that
// replace `props.data` (or `.inputs?.map(...)` returning a fresh array each
// run) keep tripping the watch and queue endless live-runs. Same trick the
// Compositor's render watcher uses.
watch(() => JSON.stringify(props.data.widgetsValues ?? []), scheduleLiveRun)
// Fire when input connections change (via live edges or pre-loaded .link).
watch(connectionFingerprint, scheduleLiveRun)

function openCompositorEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openCompositor', { detail: { nodeId: props.id } }))
}

function openAsciiOptions() {
  window.dispatchEvent(new CustomEvent('sailor:openAsciiOptions', { detail: { nodeId: props.id } }))
}

function openCrossfadeEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openCrossfade', { detail: { nodeId: props.id } }))
}

function openSmartLayoutEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openSmartLayout', { detail: { nodeId: props.id } }))
}

function openBatchExport() {
  window.dispatchEvent(new CustomEvent('sailor:openBatchExport', { detail: { nodeId: props.id } }))
}

// MaskExtractor: clicking on the preview updates the `points` JSON widget so
// the next live-preview run uses those clicks as SAM prompts.
// - Plain click: reset to a single positive point at the click location.
// - Shift-click: add a positive point.
// - Alt-Shift-click: add a negative point (subtract).
const previewNaturalDims = ref<{ w: number; h: number } | null>(null)
function onPreviewImgLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    previewNaturalDims.value = { w: img.naturalWidth, h: img.naturalHeight }
  }
}

function _maskExtractorPointsRaw(): { x: number; y: number; label: number }[] {
  if (props.data.nodeType !== 'MaskExtractor') return []
  const defs = props.data.widgetDefs as any[]
  const idx = defs.findIndex((d: any) => d.name === 'points')
  if (idx < 0) return []
  try {
    const arr = JSON.parse(props.data.widgetsValues?.[idx] ?? '[]')
    if (Array.isArray(arr)) return arr
  } catch {}
  return []
}

const maskExtractorPoints = computed(() => _maskExtractorPointsRaw())

function _lensFocusPoint(): { x: number; y: number } | null {
  if (props.data.nodeType !== 'LensBlur') return null
  const defs = props.data.widgetDefs as any[]
  const idx = defs?.findIndex((d: any) => d.name === 'focus_point') ?? -1
  if (idx < 0) return null
  try {
    const o = JSON.parse(props.data.widgetsValues?.[idx] ?? '{}')
    if (Number.isFinite(+o.x) && Number.isFinite(+o.y)) return { x: +o.x, y: +o.y }
  } catch {}
  return { x: 0.5, y: 0.5 }
}
const lensFocusPoint = computed(() => _lensFocusPoint())

// LensBlur: selecting a preset populates the character sliders (a starting
// point the user can then tweak). Values mirror comfy_extras/_lens.py
// LENS_PRESETS (DEFAULT_PARAMS merged with each preset's overrides).
const LENS_PRESET_VALUES: Record<string, Record<string, any>> = {
  '85mm Portrait': { bokeh_shape: 'circular', highlight_bokeh: 0.6, chromatic_aberration: 0.0, vignette: 0.25, focal_length: 0.6 },
  'Vintage Swirly': { bokeh_shape: 'circular', highlight_bokeh: 0.5, chromatic_aberration: 0.4, vignette: 0.5, focal_length: 0.0 },
  'Anamorphic': { bokeh_shape: 'anamorphic', highlight_bokeh: 0.7, chromatic_aberration: 0.2, vignette: 0.0, focal_length: 0.3 },
  'Clean': { bokeh_shape: 'hexagonal', highlight_bokeh: 0.2, chromatic_aberration: 0.0, vignette: 0.0, focal_length: 0.0 },
}

function _widgetIndexByName(name: string): number {
  const defs = props.data.widgetDefs as any[]
  return defs?.findIndex((d: any) => d.name === name) ?? -1
}

// When lens_preset changes to a named preset, copy its values into the sliders.
watch(
  () => {
    if (props.data.nodeType !== 'LensBlur') return undefined
    const i = _widgetIndexByName('lens_preset')
    return i >= 0 ? props.data.widgetsValues?.[i] : undefined
  },
  (preset) => {
    if (props.data.nodeType !== 'LensBlur') return
    const values = preset ? LENS_PRESET_VALUES[preset as string] : undefined
    if (!values || !Array.isArray(props.data.widgetsValues)) return
    for (const [name, val] of Object.entries(values)) {
      const i = _widgetIndexByName(name)
      if (i >= 0) props.data.widgetsValues[i] = val
    }
  },
)

function onPreviewClick(e: MouseEvent) {
  if (props.data.nodeType !== 'MaskExtractor' && props.data.nodeType !== 'LensBlur') return
  const img = e.currentTarget as HTMLImageElement
  const rect = img.getBoundingClientRect()
  const natW = img.naturalWidth || rect.width
  const natH = img.naturalHeight || rect.height
  const imgAspect = natW / natH
  const boxAspect = rect.width / rect.height
  let drawW: number, drawH: number, offX: number, offY: number
  if (imgAspect > boxAspect) {
    drawW = rect.width
    drawH = rect.width / imgAspect
    offX = 0
    offY = (rect.height - drawH) / 2
  } else {
    drawH = rect.height
    drawW = rect.height * imgAspect
    offY = 0
    offX = (rect.width - drawW) / 2
  }
  const px = e.clientX - rect.left - offX
  const py = e.clientY - rect.top - offY
  if (px < 0 || py < 0 || px > drawW || py > drawH) return
  const nx = Math.max(0, Math.min(1, px / drawW))
  const ny = Math.max(0, Math.min(1, py / drawH))

  if (props.data.nodeType === 'LensBlur') {
    const ldefs = props.data.widgetDefs as any[]
    const lidx = ldefs.findIndex((d: any) => d.name === 'focus_point')
    if (lidx < 0) return
    if (!Array.isArray(props.data.widgetsValues)) return
    props.data.widgetsValues[lidx] = JSON.stringify({ x: nx, y: ny })
    return
  }

  const defs = props.data.widgetDefs as any[]
  const idx = defs.findIndex((d: any) => d.name === 'points')
  if (idx < 0) return
  const newPoint = { x: nx, y: ny, label: e.altKey ? 0 : 1 }
  let next: any[]
  if (e.shiftKey) {
    next = [..._maskExtractorPointsRaw(), newPoint]
  } else {
    next = [newPoint]
  }
  props.data.widgetsValues[idx] = JSON.stringify(next)
}

// LoadImage / LoadVideo / LoadAudio upload handling. All go through /upload/image
// (Comfy's endpoint writes whatever file you give it). The widget name that
// holds the filename differs by node.
const fileInputRef = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

const UPLOAD_WIDGET_NAME: Record<string, string> = {
  LoadImage: 'image',
  LoadVideo: 'file',
  LoadVideoFrames: 'file',
  LoadAudio: 'audio',
}

async function handleUpload(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  const nodeType = props.data.nodeType
  const widgetName = UPLOAD_WIDGET_NAME[nodeType] ?? 'image'
  const widgetIdx = props.data.widgetDefs?.findIndex((d: any) => d.name === widgetName) ?? 0

  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('image', file)
    formData.append('overwrite', 'true')
    const res = await fetch('/upload/image', { method: 'POST', body: formData })
    if (!res.ok) throw new Error(`upload returned ${res.status}`)
    const data = await res.json()
    const name = data?.name ?? file.name
    if (props.data.widgetsValues) {
      props.data.widgetsValues[widgetIdx >= 0 ? widgetIdx : 0] = name
    }
    // Add to combo options if not already present, so the dropdown stays useful.
    const def = props.data.widgetDefs?.find((d: any) => d.name === widgetName)
    if (def && Array.isArray(def.options) && !def.options.includes(name)) {
      def.options.push(name)
    }
  } catch (err) {
    console.error(`[${nodeType}] upload failed:`, err)
  } finally {
    uploading.value = false
    target.value = ''
  }
}

// Optional access to the live VueFlow graph (provided by VueNodeCanvas).
// (injectedNodes / injectedEdges are declared above the dynamic-grow logic.)

function getUpstreamImage(portName: string): string | null {
  if (!injectedNodes?.value || !injectedEdges?.value) return null
  const portIdx = (props.data.inputs as any[])?.findIndex((i: any) => i.name === portName)
  if (portIdx == null || portIdx < 0) return null
  const edge = injectedEdges.value.find((e: any) =>
    e.target === props.id && e.targetHandle === `input-${portIdx}`)
  if (!edge) return null
  const src = injectedNodes.value.find((n: any) => n.id === edge.source)
  if (!src) return null
  if (src.data?.images?.length) return src.data.images[0]
  if (src.data?.nodeType === 'LoadImage' && src.data.widgetsValues?.[0]) {
    return `/view?${new URLSearchParams({ filename: src.data.widgetsValues[0], type: 'input' })}`
  }
  return null
}

// --- Outpaint zone visualization (OutpaintImageNode only) -------------------
// A schematic on the node showing the original image inside the expanded
// canvas, with the new (to-be-generated) area hatched. Updates live as the
// model / direction / aspect-ratio widgets change. Geometry is exact for
// Zoom-out / Make-square / Bria aspect ratios; directional outpaints use a
// representative extent (the API doesn't expose the exact amount).
const outpaintSrcAR = ref(1)
function onOutpaintImgLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth && img.naturalHeight) {
    outpaintSrcAR.value = img.naturalWidth / img.naturalHeight
  }
}
const outpaintSrc = computed(() =>
  props.data.nodeType === 'OutpaintImageNode' ? getUpstreamImage('image') : null)

const outpaintGeom = computed(() => {
  if (props.data.nodeType !== 'OutpaintImageNode') return null
  const wv = props.data.widgetsValues || []
  const model = wv[widgetIndex('model')] ?? 'Flux Fill'
  const ar = outpaintSrcAR.value || 1
  // Original rect, normalized so its longer side = 1.
  const ow = ar >= 1 ? 1 : ar
  const oh = ar >= 1 ? 1 / ar : 1
  let cw = ow, ch = oh, ox = 0, oy = 0
  let approx = false

  if (model === 'Bria Expand') {
    const [rw, rh] = String(wv[widgetIndex('aspect_ratio')] ?? '16:9').split(':').map(Number)
    const targetAR = (rw || 16) / (rh || 9)
    if (targetAR >= ow / oh) { ch = oh; cw = oh * targetAR } else { cw = ow; ch = ow / targetAR }
    ox = (cw - ow) / 2; oy = (ch - oh) / 2
  } else {
    const dir = wv[widgetIndex('direction')] ?? 'Zoom out 1.5x'
    const ext = 0.5  // representative directional extent
    if (dir === 'Zoom out 1.5x') { cw = ow * 1.5; ch = oh * 1.5; ox = (cw - ow) / 2; oy = (ch - oh) / 2 }
    else if (dir === 'Zoom out 2x') { cw = ow * 2; ch = oh * 2; ox = (cw - ow) / 2; oy = (ch - oh) / 2 }
    else if (dir === 'Make square') { const s = Math.max(ow, oh); cw = s; ch = s; ox = (s - ow) / 2; oy = (s - oh) / 2 }
    else if (dir === 'Left outpaint') { cw = ow * (1 + ext); ch = oh; ox = ow * ext; oy = 0; approx = true }
    else if (dir === 'Right outpaint') { cw = ow * (1 + ext); ch = oh; ox = 0; oy = 0; approx = true }
    else if (dir === 'Top outpaint') { cw = ow; ch = oh * (1 + ext); ox = 0; oy = oh * ext; approx = true }
    else if (dir === 'Bottom outpaint') { cw = ow; ch = oh * (1 + ext); ox = 0; oy = 0; approx = true }
  }
  // Fit the whole canvas into a display box, preserving aspect.
  const MAXW = 232, MAXH = 150
  const s = Math.min(MAXW / cw, MAXH / ch)
  const pct = Math.round((ow * oh) / (cw * ch) * 100)
  // Display-space (px) rects for the HTML/CSS render.
  return {
    dispW: Math.round(cw * s), dispH: Math.round(ch * s),
    thumbLeft: ox * s, thumbTop: oy * s, thumbW: ow * s, thumbH: oh * s,
    pct, approx,
  }
})

// --- Lens · 3D Reframe visualizer --------------------------------------------
// A focal-length strip (per lens) + a live field-of-view / compression diagram,
// shown alongside the source/target dropdowns. Clicking a chip writes the matching
// lens dropdown widget; the strips highlight whatever the dropdowns hold (two-way).
// Mirrors comfy_extras/_lenses.py.
const LENS_VIZ = [
  { mm: 16, name: 'Ultra-Wide 16mm', tag: 'ultra-wide', note: 'expands the field — the foreground looms and the background is pushed far back' },
  { mm: 24, name: 'Wide 24mm Art', tag: 'wide', note: 'environmental wide angle with gentle foreground emphasis' },
  { mm: 35, name: 'Classic 35mm Summilux', tag: 'natural wide', note: 'relaxed, true-to-life documentary perspective' },
  { mm: 50, name: 'Normal 50mm Planar', tag: 'neutral', note: 'eye-like field of view, no compression or distortion' },
  { mm: 85, name: 'Portrait 85mm GM', tag: 'telephoto', note: 'flattering compression, smooth background separation' },
  { mm: 135, name: 'Tele 135mm f/2', tag: 'strong tele', note: 'flattens depth with a narrow field of view' },
  { mm: 200, name: 'Long 200mm', tag: 'super-tele', note: 'the scene flattens and the background stacks in tight' },
]

function lensFov(mm: number): number { return 2 * Math.atan(18 / mm) * 180 / Math.PI }

function _lensWidgetVal(name: string): string | undefined {
  const i = widgetIndex(name)
  return i >= 0 ? props.data.widgetsValues?.[i] : undefined
}
function setLens(widgetName: string, lensName: string) {
  const i = widgetIndex(widgetName)
  if (i < 0 || !Array.isArray(props.data.widgetsValues)) return
  props.data.widgetsValues[i] = lensName
}
const lensSourceName = computed(() => _lensWidgetVal('source_lens'))
const lensTargetName = computed(() => _lensWidgetVal('target_lens'))

const lensDiagram = computed(() => {
  if (props.data.nodeType !== 'LensReframe') return null
  const lens = LENS_VIZ.find(l => l.name === lensTargetName.value)
  const mm = lens ? lens.mm : (Number(_lensWidgetVal('custom_focal')) || 50)
  const ang = lensFov(mm) / 2 * Math.PI / 180
  const camX = 26, camY = 75, reach = 264
  const ty = Math.max(8, camY - Math.tan(ang) * reach)
  const by = Math.min(142, camY + Math.tan(ang) * reach)
  const t = Math.max(0, Math.min(1, (mm - 16) / 184))   // 0 wide … 1 tele
  const bgScale = 0.45 + t * 1.15
  return {
    mm, camX, camY,
    fovDeg: Math.round(lensFov(mm)),
    fan: `M${camX} ${camY} L290 ${ty.toFixed(1)} L290 ${by.toFixed(1)} Z`,
    bgX: (250 - t * 55).toFixed(1), bgRx: (30 * bgScale).toFixed(1), bgRy: (23 * bgScale).toFixed(1),
    tag: lens ? lens.tag : 'custom',
    note: (s => s.charAt(0).toUpperCase() + s.slice(1))(lens ? lens.note : `${Math.round(mm)}mm custom lens`),
  }
})

// --- Edit as Frame (layer-splitting nodes) -----------------------------------
// Layerize / Split-photo deconstruct a flat image into layers; this hands the
// result to a Frame artifact (wired image layers + — for Layerize — the text
// containers converted into editable local text layers). The canvas owns the
// node/edge creation; we just announce the intent.
const showEditAsFrame = computed(() =>
  props.data.nodeType === 'LayerizeGraphicNode'
  || props.data.nodeType === 'SplitPhotoLayersNode'
  || props.data.nodeType === 'SeedreamLayerizeNode')
const editAsFrameReady = computed(() => {
  // Layerize needs its run result — the text layers live in the layers_json
  // payload (mirrored to data.text). Split-photo only wires outputs, so the
  // Frame can be created before the first run. Seedream also carries its
  // layers_json in data.text, same as Layerize.
  if (props.data.nodeType === 'LayerizeGraphicNode' || props.data.nodeType === 'SeedreamLayerizeNode')
    return !!(props.data as any).text
  return true
})
function editAsFrame() {
  window.dispatchEvent(new CustomEvent('sailor:editAsFrame', { detail: { nodeId: props.id } }))
}

// Compute preview images: from execution output or LoadImage widget value
const previewImages = computed(() => {
  // A single run can produce several images: Smart Layout emits one per format,
  // and any node downstream of a list output runs once per item. Show the whole
  // set from the most recent run (takes sharing one prompt id) so every result
  // is visible in the carousel — not just the active take. Display only: the
  // node's own `data.images` (its output / wiring) is left untouched.
  const takes = props.data.takes as Array<{ promptId?: string | null; images?: string[] }> | undefined
  if (takes?.length) {
    const latest = takes[takes.length - 1]!
    const runId = latest.promptId
    const set = (runId ? takes.filter(t => t.promptId === runId) : [latest])
      .flatMap(t => t.images ?? [])
    if (set.length > 1) return set
  }

  // Execution output images (PreviewImage, SaveImage, etc.)
  if (props.data.images?.length) return props.data.images

  // LoadImage: first widget value is the filename, served from /view?type=input
  if (props.data.nodeType === 'LoadImage' && props.data.widgetsValues?.[0]) {
    const filename = props.data.widgetsValues[0]
    return [`/view?${new URLSearchParams({ filename, type: 'input' })}`]
  }

  // LoadVideo / LoadVideoFrames: the 'file' widget holds the filename.
  // `isVideo` keys off the extension to render a <video> element instead of an <img>.
  if (props.data.nodeType === 'LoadVideo' || props.data.nodeType === 'LoadVideoFrames') {
    const fileIdx = props.data.widgetDefs?.findIndex((d: any) => d.name === 'file') ?? 0
    const filename = props.data.widgetsValues?.[fileIdx >= 0 ? fileIdx : 0]
    if (filename) {
      return [`/view?${new URLSearchParams({ filename, type: 'input' })}`]
    }
  }

  // MaskExtractor: show the upstream source image as a fallback so the user
  // can click on it before SAM has produced its first output.
  if (props.data.nodeType === 'MaskExtractor') {
    const upstream = getUpstreamImage('image')
    if (upstream) return [upstream]
  }

  return []
})

// Displayed images lag `previewImages` by one preload — we only swap the
// rendered <img> src once the new image is fully loaded in the browser cache.
// This eliminates the white flicker that live-preview cache-busting would
// otherwise cause on every slider tweak.
const displayedImages = ref<string[]>([])
// Collapse the inline result preview to declutter the canvas (per-node, local).
// Collapsed by default — the result shows as a dims hint until expanded.
const previewCollapsed = ref(true)
let preloadBatch = 0

// Carousel state — used by nodes that produce a set of related images
// (SmartLayout: one PNG per aspect). Resets to 0 whenever the image set
// changes so a fresh render always lands on the first card.
const carouselIndex = ref(0)

// Derive a human-readable label for each carousel slot. SmartLayout's preview
// filenames embed the aspect key (live_preview_<id>_<aspect>.png) so we can
// pluck it back out; fall back to the index when the pattern doesn't match.
function carouselLabel(url: string, fallback: number): string {
  const m = /live_preview_[^_]+_([^/?]+?)\.png/.exec(url)
  if (m && m[1]) {
    try { return decodeURIComponent(m[1]) } catch { return m[1] }
  }
  return String(fallback + 1)
}

// Trigger a browser download for the currently visible image. Uses a fetch
// → blob → anchor.download pattern so the file lands with a friendly name
// (template_<aspect>.png) even though the URL is `/view?filename=…`.
async function downloadCarouselImage(url: string, label: string) {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const obj = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = obj
    a.download = `smartlayout_${label}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(obj)
  } catch (err) {
    console.error('[ComfyNode] carousel download failed:', err)
  }
}

watch(previewImages, (urls) => {
  if (!urls || !urls.length) {
    displayedImages.value = []
    carouselIndex.value = 0
    return
  }
  // Snap back to the first slot so a new render set is shown from the start.
  carouselIndex.value = 0
  // Tag this batch so a slower-completing earlier batch can't overwrite the
  // commit from a newer batch when the user drags sliders rapidly.
  const myBatch = ++preloadBatch
  let pending = urls.length
  const onDone = () => {
    pending--
    if (pending === 0 && myBatch === preloadBatch) {
      displayedImages.value = urls
    }
  }
  for (const url of urls) {
    const img = new window.Image()
    img.onload = onDone
    img.onerror = onDone  // commit anyway so a broken URL doesn't freeze the preview
    img.src = url
  }
}, { immediate: true })
</script>

<template>
  <!-- Positioning wrapper. Ports are siblings of the card rather than children
       so the card's opaque background occludes each dot's inner half and the
       ports read as tucked in behind the node — a child can't paint behind its
       own parent's background. The card keeps every bit of its own chrome. -->
  <div
    ref="portSyncRoot"
    class="relative w-fit"
    :class="{ 'comfy-node-collapsed': isCapsule, 'comfy-node-pinned-open': pinnedOpen && !isCapsule }"
  >
    <VueCanvasNodePort
      v-for="(port, i) in visiblePorts"
      :id="`input-${port.idx}`"
      :key="`in-${port.idx}`"
      type="target"
      side="left"
      :index="i"
      :data-type="port.slot.type"
      :label="port.slot.name"
      :tooltip="data.nodeType === 'RestyleFromImageNode' && generateMoodboardId && port.slot.name === 'style_image'
        ? 'Moodboard is providing the style'
        : getInputTooltip(data.nodeType, port.slot.name)"
      :disabled="data.nodeType === 'RestyleFromImageNode' && !!generateMoodboardId && port.slot.name === 'style_image'"
      :connectable="!isCapsule"
    />
    <VueCanvasNodePort
      v-for="(output, i) in data.outputs"
      :id="`output-${i}`"
      :key="`out-${i}`"
      type="source"
      side="right"
      :index="i"
      :data-type="output.type"
      :label="output.name"
      :connectable="!isCapsule"
    />

  <Transition name="capsule-swap" @enter="onUnfoldEnter" @after-enter="clearUnfold" @leave="onFoldLeave" @after-leave="clearUnfold">
  <NodeCapsule
    v-if="isCapsule"
    key="capsule"
    class="comfy-node"
    :title="displayTitle"
    :readout="capsuleReadout"
    :icon="capsuleIcon"
    :state="capsuleState"
    :border-left="borderColorLeft"
    :border-right="borderColorRight"
    :width="isRecessiveNode ? 208 : 260"
    @action="onCapsuleAction"
    @expand="onExpandCapsule"
  />
  <div
    v-else
    key="card"
    class="comfy-node relative z-10 border select-none transition-opacity duration-150"
    :class="{
      'comfy-node--muted': isMuted,
      'comfy-node--bypassed': isBypassed,
      'ring-2 ring-red-500': data.error,
      // A subgraph keeps a border you can actually see — it is a signal, not chrome.
      // An ordinary node's is barely there: the card already separates itself from the
      // canvas by fill and shadow, so the outline only needs to catch the edge, not draw
      // it. 10% -> 4% -> 6% on 2026-08-06; 4% read as nothing at all.
      'border-white/30': data.isSubgraph,
      'border-white/[0.06]': !data.isSubgraph,
      // Dominant: full width. Recessive: narrower, so utilities stop competing
      // with the work. Width carries the whole distinction — recessive nodes used
      // to also sit at `opacity-70 hover:opacity-100`, dropped 2026-08-05 because
      // nothing else on the canvas dims: generators and studio nodes are always
      // opaque, so a utility fading in and out was the odd one out rather than a
      // consistent signal, and it made every control inside it hard to read.
      'w-[260px]': !isRecessiveNode,
      'w-[208px]': isRecessiveNode,
    }"
    :data-running="data.running || undefined"
    :data-mode="data.mode || 0"
    :style="{
      // Flat, not the 180deg #252525 -> #1e1e1e gradient this used to be. A gradient on a
      // 260px card reads as a sheen the controls have to compete with, and every surface
      // inside it (rows, prompt, launcher) is a flat percentage of white — so the one
      // gradient was the odd surface. #1a1a1c is also a touch darker, which gives the
      // white-ish controls more room. A user-set bgcolor still tints, now as a flat mix.
      background: data.bgcolor
        ? `color-mix(in srgb, ${data.bgcolor} 28%, #1a1a1c)`
        : '#1a1a1c',
      '--border-color-left': borderColorLeft,
      '--border-color-right': borderColorRight,
      // Short nodes with many ports must still enclose their own dots.
      minHeight: `${portsMinHeight}px`,
    } as any"
  >
    <!-- Agent "scanning" overlay — runs while the agent reviews THIS node. -->
    <VueCanvasAgentScanOverlay :active="isAnalyzing" />
    <!-- Mode overlay: bypass shows diagonal stripes; mute shows soft scrim -->
    <div
      v-if="isMuted || isBypassed"
      class="pointer-events-none absolute inset-0 rounded-xl z-[5]"
      :class="isBypassed ? 'comfy-node-stripes' : 'bg-black/30'"
    />
    <!-- Mode badge (top-right) -->
    <div
      v-if="isMuted || isBypassed"
      class="pointer-events-none absolute top-1.5 right-1.5 z-[6] text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
      :class="isBypassed
        ? 'bg-amber-500/25 text-amber-200 border border-amber-400/30'
        : 'bg-white/15 text-white/70 border border-white/15'"
    >
      {{ isBypassed ? 'Bypass' : 'Mute' }}
    </div>
    <!-- Title bar -->
    <div
      class="node-head flex items-center border-b border-white/5"
      @mouseenter="measureTitle"
      :style="{ background: `linear-gradient(135deg, ${accentColor}15 0%, transparent 60%)` }"
    >
      <!-- Subgraph icon → partner icon → toolbox icon. No fallback dot:
           if nothing resolves, the title fills the space instead. -->
      <span v-if="hasHeaderIcon" class="node-head__tile">
      <svg v-if="data.isSubgraph" class="text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="2" width="8" height="8" rx="1" /><rect x="14" y="2" width="8" height="8" rx="1" /><rect x="8" y="14" width="8" height="8" rx="1" />
      </svg>
      <!-- Per-node generator icon takes precedence over provider logo: a
           Flux Dev card and a Veo card from the same provider should read
           differently at a glance, not as two identical Replicate clouds. -->
      <component v-else-if="generatorIcon" :is="generatorIcon" class="text-white/70" :stroke-width="1.75" />
      <img v-else-if="partnerIconUrl" :src="partnerIconUrl" class="rounded-sm" />
      <component v-else-if="toolboxIcon" :is="toolboxIcon" class="text-white/70" :stroke-width="1.75" />
      </span>
      <span ref="titleClipEl" class="node-head__title text-xs font-semibold text-white/90">
        <span>{{ data.subgraphName || displayTitle }}</span>
      </span>
      <!-- Seed lock: fix the seed so every run keeps the same options. Shares
           state with the inspector's seed widget. -->
      <button
        v-if="hasSeed"
        class="nopan nodrag shrink-0 size-5 rounded-[6px] flex items-center justify-center transition-colors cursor-pointer"
        :class="seedLocked
          ? 'text-amber-300 bg-amber-400/15'
          : 'text-white/40 hover:text-white/80 hover:bg-white/[0.08]'"
        :title="seedLocked
          ? 'Seed locked — same options every run. Click to unlock.'
          : 'Lock the seed so every run keeps the same options.'"
        @click.stop="toggleSeedLock"
      >
        <component :is="seedLocked ? Lock : LockOpen" class="size-3.5" />
      </button>
      <!-- Critique: have the agent LOOK at this node's result and suggest fixes
           (run→look→fix, on-demand). Only once there's an output to judge. -->
      <button
        v-if="data.images?.length"
        class="nopan nodrag shrink-0 size-5 rounded-[6px] flex items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/[0.08] transition-colors cursor-pointer"
        title="Critique result — look at the output and suggest fixes"
        @click.stop="critiqueResult"
      >
        <Sparkles class="size-3.5" />
      </button>
      <!-- Node settings: opens the right-hand inspector for this node's
           mechanical params (seed / aspect / advanced). Only when it has some. -->
      <button
        v-if="hasInspectorSettings"
        class="nopan nodrag shrink-0 size-5 rounded-[6px] flex items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/[0.08] transition-colors cursor-pointer"
        title="Node settings"
        @click.stop="openInspector"
      >
        <SlidersHorizontal class="size-3.5" />
      </button>
      <!-- Subgraph node count badge -->
      <span
        v-if="data.isSubgraph && data.innerNodeCount"
        class="shrink-0 text-[8px] font-medium px-1.5 py-0.5 rounded-full bg-white/20 text-white/70 border border-white/20"
      >{{ data.innerNodeCount }} nodes</span>
      <span
        v-else-if="priceLabel"
        class="shrink-0 text-[8px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/20 tabular-nums"
      >{{ priceLabel }}</span>
    </div>

    <!-- Inline error banner — persists until the next successful run on
         this node. Toasts disappear; this keeps the failure reason visible
         next to the node that actually failed. -->
    <div
      v-if="data.error && data.errorMessage"
      class="px-3 py-1.5 bg-red-500/15 border-b border-red-500/20 text-[10.5px] text-red-200 leading-snug max-h-[80px] overflow-auto nopan nodrag select-text"
      :title="data.errorMessage"
    >
      {{ data.errorMessage }}
    </div>


    <!-- Outpaint zone preview: original image inside the expanded canvas,
         new area hatched. OutpaintImageNode only. Pure HTML/CSS so it never
         re-decodes the source image during canvas pan/zoom (SVG <image> did). -->
    <div v-if="data.nodeType === 'OutpaintImageNode' && outpaintGeom"
         class="px-2.5 py-4 flex flex-col items-center gap-2">
      <div class="op-canvas relative overflow-hidden rounded-[3px]"
           :style="{ width: outpaintGeom.dispW + 'px', height: outpaintGeom.dispH + 'px' }">
        <!-- Original image (thumbnail if wired, else solid block) -->
        <img v-if="outpaintSrc" :src="outpaintSrc" alt="" draggable="false"
             class="absolute object-fill select-none pointer-events-none"
             :style="{ left: outpaintGeom.thumbLeft + 'px', top: outpaintGeom.thumbTop + 'px',
                       width: outpaintGeom.thumbW + 'px', height: outpaintGeom.thumbH + 'px',
                       outline: '1px solid #e8e8e8', outlineOffset: '-1px' }"
             @load="onOutpaintImgLoad">
        <div v-else class="absolute bg-[#3a3a3a]"
             :style="{ left: outpaintGeom.thumbLeft + 'px', top: outpaintGeom.thumbTop + 'px',
                       width: outpaintGeom.thumbW + 'px', height: outpaintGeom.thumbH + 'px' }" />
      </div>
      <span class="text-[9px] text-[#6f6f6f] leading-none">
        new area · original {{ outpaintGeom.pct }}% of canvas{{ outpaintGeom.approx ? ' (approx)' : '' }}
      </span>
    </div>

    <!-- Edit as Frame: hand the split layers to a Frame artifact -->
    <div v-if="showEditAsFrame" class="px-2.5 py-4">
      <button
        class="w-full flex items-center justify-center gap-2 rounded-[6px] py-1.5 text-[11px] font-medium transition-colors"
        :class="editAsFrameReady
          ? 'bg-white/[0.07] hover:bg-white/[0.14] text-white/85 cursor-pointer'
          : 'bg-white/[0.03] text-white/30 cursor-not-allowed'"
        :disabled="!editAsFrameReady"
        :title="editAsFrameReady
          ? 'Create a Frame with these results as editable layers'
          : 'Run the node first — the editable text layers come from the result'"
        @click.stop="editAsFrame"
      >
        <Frame class="size-3.5" />
        Edit as Frame
      </button>
    </div>

    <!-- Widgets (Compositor / SmartLayout edit via their dedicated modal/body, so we hide the inline controls) -->
    <!-- No horizontal padding on this block: every ComfyNodeWidget insets ITSELF by 10px,
         so padding here doubles it — measured as a 21px field inset before this. -->
    <div v-if="data.widgetDefs?.some(w => !w.hidden) && data.nodeType !== 'Compositor' && data.nodeType !== 'Timeline' && data.nodeType !== 'SmartLayout'" class="py-4 flex flex-col gap-2">
      <!-- Ungrouped widgets render first. Seed widgets carry a lock state
           that controls whether the pre-Run randomizer touches them. For
           Comfy-standard seeds it lives at widgets_values[i+1] (the
           control_after_generate slot); everything else stores it in
           node.properties.seedLocks so non-standard generators (Replicate,
           custom nodes) get the same toggle. -->
      <template v-for="{ widget, i } in orderedWidgets" :key="widget.name">
        <VueCanvasComfyNodeWidget
          v-if="!widget.hidden && !widget.advanced && widget.sailor_widget !== 'internal' && isWidgetVisible(widget) && !groupedWidgetNames.has(widget.name) && !foldedScaleNames.has(widget.name) && !isInspectorWidgetDef(widget)"
          :widget-def="effectiveWidgetDef(widget)"
          :node-type="data.nodeType"
          :node-id="id"
          :model-value="data.widgetsValues?.[i]"
          :is-fixed="isSeedFixed(widget, i)"
          :scale-def="loraScaleDef(widget.name)"
          :scale-value="loraScaleValue(widget.name)"
          :moodboard-id="moodboardIdForPicker(widget.name) ?? undefined"
          @update:model-value="data.widgetsValues[i] = $event"
          @update:is-fixed="setSeedFixed(widget, i, $event)"
          @update:scale="setLoraScale(widget.name, $event)"
          @clear="clearLoraSlot(widget.name)"
        />
      </template>
      <!-- Moodboard chip — Generate-an-image only (moodboards Plan B, Task B2).
           A node-face row, not a widget: its backing style_block input is
           internal/hidden and the applied board lives in node properties. -->
      <div v-if="data.nodeType === 'GenerateImageNode' || data.nodeType === 'RestyleFromImageNode'" class="px-2.5">
        <WidgetMoodboardChip
          :moodboard-id="generateMoodboardId ?? undefined"
          :has-refs="generateMoodboardHasRefs"
          :switched-from="generateMoodboardSwitchedFrom ?? undefined"
          @open="openGenerateMoodboardGallery"
          @clear="clearGenerateMoodboard"
          @revert="revertGenerateMoodboardSwitch"
        />
      </div>
      <!-- Grouped widgets render under collapsible headers. For Compositor we
           hide layer groups whose layer index is beyond the visible-input
           count, so the body stays in sync with the grow-on-connect ports. -->
      <template v-for="group in visibleWidgetGroups" :key="group.title">
        <!-- `mt-1.5` on top of the container's `gap-2`: this disclosure opens a new
             group, so it takes the 12px group gap rather than the 6px that separates one
             widget from the next. Without it, ADVANCED sat as close to the last control
             as two controls sit to each other. -->
        <div class="px-2.5 mt-2 nopan nodrag">
          <button
            class="flex items-center gap-1 w-full text-[10px] uppercase tracking-[0.08em] text-white/50 hover:text-white/80 cursor-pointer py-1 transition-colors"
            @click="toggleGroup(group.title)"
          >
            <ChevronRight class="size-3 transition-transform" :class="!collapsedGroups.has(group.title) ? 'rotate-90' : ''" />
            <span>{{ group.title }}</span>
          </button>
        </div>
        <template v-if="!collapsedGroups.has(group.title)">
          <VueCanvasComfyNodeWidget
            v-for="widget in widgetsInGroup(group.title)"
            :key="widget.name"
            :widget-def="effectiveWidgetDef(widget)"
            :node-type="data.nodeType"
            :model-value="data.widgetsValues?.[widgetIndex(widget.name)]"
            :is-fixed="isSeedFixed(widget, widgetIndex(widget.name))"
            @update:model-value="data.widgetsValues[widgetIndex(widget.name)] = $event"
            @update:is-fixed="setSeedFixed(widget, widgetIndex(widget.name), $event)"
          />
        </template>
      </template>

      <!-- No `border-t` between groups any more: 16px of space says "new group" without
           a line, and eight hairlines down a 260px card read as a form rather than a
           thing. The header keeps its hairline — that one divides chrome from content. -->
      <!-- Advanced inputs (collapsed by default) — any input flagged
           `advanced` in the schema, e.g. the multi-LoRA node's URL overrides
           and sampler knobs, so the node shows only its core controls. -->
      <template v-if="advancedWidgets.length">
        <!-- `mt-1.5` on top of the container's `gap-2`: this disclosure opens a new
             group, so it takes the 12px group gap rather than the 6px that separates one
             widget from the next. Without it, ADVANCED sat as close to the last control
             as two controls sit to each other. -->
        <div class="px-2.5 mt-2 nopan nodrag">
          <button
            class="flex items-center gap-1 w-full text-[10px] uppercase tracking-[0.08em] text-white/50 hover:text-white/80 cursor-pointer py-1 transition-colors"
            @click="advancedOpen = !advancedOpen"
          >
            <ChevronRight class="size-3 transition-transform" :class="advancedOpen ? 'rotate-90' : ''" />
            <span>Advanced</span>
          </button>
        </div>
        <template v-if="advancedOpen">
          <VueCanvasComfyNodeWidget
            v-for="widget in advancedWidgets"
            :key="widget.name"
            :widget-def="effectiveWidgetDef(widget)"
            :node-type="data.nodeType"
            :node-id="id"
            :model-value="data.widgetsValues?.[widgetIndex(widget.name)]"
            :is-fixed="isSeedFixed(widget, widgetIndex(widget.name))"
            @update:model-value="data.widgetsValues[widgetIndex(widget.name)] = $event"
            @update:is-fixed="setSeedFixed(widget, widgetIndex(widget.name), $event)"
          />
        </template>
      </template>

      <!-- The schema-free "Style"/aesthetic field moved to the NodeInspector. -->
    </div>

    <!-- Lens · 3D Reframe: focal-length strips + live FOV / compression diagram.
         Companion to the source/target dropdowns — clicking a chip writes the
         matching lens widget; chips highlight whatever the dropdowns hold. -->
    <div v-if="data.nodeType === 'LensReframe'" class="px-2.5 py-4 flex flex-col gap-2 nopan nodrag">
      <div>
        <div class="text-[10px] text-white/40 mb-1">Shot on</div>
        <div class="flex gap-1">
          <button
            v-for="l in LENS_VIZ" :key="'s' + l.mm" :title="l.name"
            class="flex-1 py-1 rounded-[6px] text-[10px] cursor-pointer border transition-colors"
            :class="lensSourceName === l.name
              ? 'bg-white/15 text-white/70 border-white/30'
              : 'bg-white/[0.04] text-white/55 border-white/10 hover:bg-white/[0.08]'"
            @click.stop="setLens('source_lens', l.name)"
          >{{ l.mm }}</button>
        </div>
      </div>

      <div>
        <div class="flex justify-between items-baseline mb-1">
          <span class="text-[10px] text-white/40">Re-shoot as</span>
          <span v-if="lensDiagram" class="text-[10px] text-white/70">{{ lensDiagram.mm }}mm · {{ lensDiagram.tag }}</span>
        </div>
        <div class="flex gap-1">
          <button
            v-for="l in LENS_VIZ" :key="'t' + l.mm" :title="l.name"
            class="flex-1 py-1 rounded-[6px] text-[10px] cursor-pointer border transition-colors"
            :class="lensTargetName === l.name
              ? 'bg-white/15 text-white/70 border-white/30'
              : 'bg-white/[0.04] text-white/55 border-white/10 hover:bg-white/[0.08]'"
            @click.stop="setLens('target_lens', l.name)"
          >{{ l.mm }}</button>
        </div>
        <div class="flex justify-between text-[9px] text-white/30 mt-1 px-0.5">
          <span>wider</span><span>longer</span>
        </div>
      </div>

      <div v-if="lensDiagram" class="bg-[#161617] border border-[#262628] rounded-[8px] p-1">
        <svg viewBox="0 0 300 150" class="w-full block">
          <line :x1="lensDiagram.camX" :y1="lensDiagram.camY" x2="290" :y2="lensDiagram.camY"
                stroke="#2f2f31" stroke-width="1" stroke-dasharray="3 3" />
          <path :d="lensDiagram.fan" fill="rgba(52,211,153,0.09)" stroke="rgba(52,211,153,0.45)" stroke-width="1" />
          <ellipse :cx="lensDiagram.bgX" :cy="lensDiagram.camY + 6" :rx="lensDiagram.bgRx" :ry="lensDiagram.bgRy"
                   fill="#2b2b2e" stroke="#3a3a3d" stroke-width="1" />
          <g transform="translate(150,52)">
            <circle cx="0" cy="8" r="7" fill="#d8a878" />
            <rect x="-7" y="16" width="14" height="34" rx="6" fill="#d8a878" />
          </g>
          <text x="150" y="118" text-anchor="middle" font-size="8" fill="rgba(255,255,255,0.35)">subject</text>
          <g :transform="`translate(${lensDiagram.camX - 4},${lensDiagram.camY})`">
            <rect x="-9" y="-8" width="18" height="16" rx="3" fill="#34d399" />
            <circle cx="0" cy="0" r="4" fill="#161617" />
          </g>
          <text x="150" y="13" text-anchor="middle" font-size="9.5" fill="rgba(255,255,255,0.5)">{{ lensDiagram.fovDeg }}° field of view</text>
        </svg>
      </div>
      <div v-if="lensDiagram" class="text-[10px] text-white/55 text-center leading-snug">{{ lensDiagram.note }}</div>
    </div>

    <!-- Compositor: open the editor modal -->
    <div v-if="data.nodeType === 'Compositor'" class="px-2 pb-2 nopan nodrag">
      <button
        class="flex items-center justify-center gap-2 w-full h-7 rounded-[6px] bg-white/[0.06] hover:bg-white/[0.1] text-white/70 hover:text-white/90 text-xs transition-colors cursor-pointer border border-white/10"
        @click="openCompositorEditor"
      >
        Open editor
      </button>
    </div>

    <!-- Ascii: open the glyph-dither options panel -->
    <div v-if="data.nodeType === 'Ascii'" class="px-2 pb-2 nopan nodrag">
      <button
        class="flex items-center justify-center gap-2 w-full h-7 rounded-[6px] bg-white/[0.06] hover:bg-white/[0.1] text-white/70 hover:text-white/90 text-xs transition-colors cursor-pointer border border-white/10"
        @click="openAsciiOptions"
      >
        More options
      </button>
    </div>

    <!-- Crossfade: open the visual editor modal -->
    <div v-if="data.nodeType === 'VideoCrossfade'" class="px-2 pb-2 nopan nodrag">
      <button
        class="flex items-center justify-center gap-2 w-full h-7 rounded-[6px] bg-white/[0.06] hover:bg-white/[0.1] text-white/70 hover:text-white/90 text-xs transition-colors cursor-pointer border border-white/10"
        @click="openCrossfadeEditor"
      >
        Open editor
      </button>
    </div>

    <!-- SmartLayout: designer-friendly body — format chips + Edit layout
         (replaces the raw layout JSON / aspects CSV / brand widgets). -->
    <VueCanvasSmartLayoutNodeBody
      v-if="data.nodeType === 'SmartLayout'"
      :data="data"
      @edit="openSmartLayoutEditor"
      @batch="openBatchExport"
    />

    <!-- LoadImage / LoadVideo / LoadVideoFrames / LoadAudio upload button -->
    <div v-if="['LoadImage', 'LoadVideo', 'LoadVideoFrames', 'LoadAudio'].includes(data.nodeType)" class="px-2 pb-2 nopan nodrag">
      <input
        ref="fileInputRef"
        type="file"
        :accept="data.nodeType === 'LoadImage' ? 'image/*' : data.nodeType === 'LoadAudio' ? 'audio/*' : 'video/*'"
        class="hidden"
        @change="handleUpload"
      />
      <button
        class="flex items-center justify-center gap-2 w-full h-7 rounded-[6px] bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-xs text-white/80 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
        :disabled="uploading"
        @click="fileInputRef?.click()"
      >
        <Upload class="size-3.5" />
        <span>
          {{ uploading
              ? 'Uploading…'
              : data.nodeType === 'LoadImage' ? 'Upload image'
              : data.nodeType === 'LoadAudio' ? 'Upload audio'
              : 'Upload video' }}
        </span>
      </button>
    </div>

    <!-- Audio previews (PreviewAudio, SaveAudio*, etc.) -->
    <div v-if="data.audios?.length" class="px-2.5 py-4 flex flex-col gap-2">
      <audio
        v-for="(src, i) in data.audios"
        :key="i"
        :src="src"
        controls
        preload="metadata"
        class="w-full nopan nodrag"
      />
    </div>

    <!-- Text output (PreviewAny "Preview as Text" + any node that returns ui.text) -->
    <div v-if="data.text" class="px-2.5 py-4">
      <pre class="text-[10.5px] text-white/80 whitespace-pre-wrap break-words font-mono leading-snug max-h-[200px] overflow-auto nopan nodrag select-text">{{ data.text }}</pre>
    </div>

    <!-- SmartLayout carousel: one card per rendered aspect, with prev/next
         arrows and a download icon on the active card. Falls back to the
         generic image branch below when the node only produced a single
         image (single-aspect render). -->
    <div
      v-else-if="data.nodeType === 'SmartLayout' && displayedImages.length"
      class="px-2.5 py-4 nopan nodrag"
    >
      <div class="relative">
        <img
          :src="displayedImages[Math.min(carouselIndex, displayedImages.length - 1)]"
          class="w-full rounded-lg object-contain max-h-[200px] bg-black/30"
          loading="lazy"
          @load="onPreviewImgLoad"
        />
        <!-- Download current -->
        <button
          class="absolute top-1.5 right-1.5 size-7 rounded-[6px] bg-black/55 hover:bg-black/75 backdrop-blur-sm text-white/85 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
          title="Download this image"
          @click.stop="downloadCarouselImage(
            displayedImages[Math.min(carouselIndex, displayedImages.length - 1)]!,
            carouselLabel(displayedImages[Math.min(carouselIndex, displayedImages.length - 1)]!, carouselIndex),
          )"
        >
          <Download class="size-3.5" />
        </button>
        <!-- Prev / Next — only when >1 image -->
        <template v-if="displayedImages.length > 1">
          <button
            class="absolute top-1/2 -translate-y-1/2 left-1.5 size-7 rounded-full bg-black/55 hover:bg-black/75 backdrop-blur-sm text-white/85 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
            title="Previous"
            @click.stop="carouselIndex = (carouselIndex - 1 + displayedImages.length) % displayedImages.length"
          >
            <ChevronLeft class="size-4" />
          </button>
          <button
            class="absolute top-1/2 -translate-y-1/2 right-1.5 size-7 rounded-full bg-black/55 hover:bg-black/75 backdrop-blur-sm text-white/85 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
            title="Next"
            @click.stop="carouselIndex = (carouselIndex + 1) % displayedImages.length"
          >
            <ChevronRight class="size-4" />
          </button>
        </template>
      </div>
      <!-- Bottom strip: dots (jump to image) + active label. Getting every
           format at once lives on "Batch export" (the node body); this strip
           just navigates + labels the previews. Single images download via the
           per-image button top-right of the preview. -->
      <div v-if="displayedImages.length > 1" class="mt-2 flex items-center gap-2">
        <div class="flex items-center gap-1">
          <button
            v-for="(_, i) in displayedImages"
            :key="i"
            class="size-1.5 rounded-full transition-colors cursor-pointer"
            :class="i === Math.min(carouselIndex, displayedImages.length - 1)
              ? 'bg-action'
              : 'bg-white/25 hover:bg-white/45'"
            :title="carouselLabel(displayedImages[i]!, i)"
            @click.stop="carouselIndex = i"
          />
        </div>
        <span class="text-[10px] text-white/45 tabular-nums">
          {{ carouselLabel(displayedImages[Math.min(carouselIndex, displayedImages.length - 1)]!, carouselIndex) }}
          <span class="text-white/25">·</span>
          {{ Math.min(carouselIndex, displayedImages.length - 1) + 1 }}/{{ displayedImages.length }}
        </span>
      </div>
    </div>

    <!-- Media previews (images or video) -->
    <div v-else-if="displayedImages.length" class="px-2.5 py-4">
      <!-- Collapse toggle: hide the result to declutter; dims stay as a hint. -->
      <button
        class="nopan nodrag w-full flex items-center gap-1 mb-1.5 text-[10px] uppercase tracking-[0.08em] text-white/45 hover:text-white/75 cursor-pointer transition-colors"
        :title="previewCollapsed ? 'Show result' : 'Hide result'"
        @click.stop="previewCollapsed = !previewCollapsed"
      >
        <ChevronRight class="size-3 transition-transform" :class="previewCollapsed ? '' : 'rotate-90'" />
        <span>{{ isVideo ? 'Video' : 'Result' }}</span>
        <span v-if="previewCollapsed && previewNaturalDims" class="ml-1 normal-case text-white/30 tabular-nums">{{ previewNaturalDims.w }}×{{ previewNaturalDims.h }}</span>
      </button>
      <template v-if="!previewCollapsed && isVideo">
        <video
          v-for="(src, i) in displayedImages"
          :key="i"
          :src="src"
          class="w-full rounded-lg object-contain max-h-[200px] ring-1 ring-inset ring-white/10"
          controls
          autoplay
          muted
          playsinline
        />
      </template>
      <template v-else-if="!previewCollapsed">
        <div v-for="(src, i) in displayedImages" :key="i" class="relative">
          <img
            :src="src"
            class="w-full rounded-lg object-contain max-h-[200px] ring-1 ring-inset ring-white/10"
            :class="{ 'cursor-crosshair': data.nodeType === 'MaskExtractor' || data.nodeType === 'LensBlur' }"
            loading="lazy"
            @load="onPreviewImgLoad"
            @click="onPreviewClick"
          />
          <!-- SAM click markers: green = positive, red = negative -->
          <svg
            v-if="data.nodeType === 'MaskExtractor' && previewNaturalDims && maskExtractorPoints.length"
            class="absolute inset-0 w-full h-full max-h-[200px] pointer-events-none rounded-lg"
            :viewBox="`0 0 ${previewNaturalDims.w} ${previewNaturalDims.h}`"
            preserveAspectRatio="xMidYMid meet"
          >
            <circle
              v-for="(p, pi) in maskExtractorPoints"
              :key="pi"
              :cx="p.x * previewNaturalDims.w"
              :cy="p.y * previewNaturalDims.h"
              :r="Math.max(previewNaturalDims.w, previewNaturalDims.h) * 0.012"
              :fill="p.label === 1 ? '#22c55e' : '#ef4444'"
              stroke="white"
              stroke-width="3"
              vector-effect="non-scaling-stroke"
            />
          </svg>
          <svg
            v-if="data.nodeType === 'LensBlur' && previewNaturalDims && lensFocusPoint"
            class="absolute inset-0 w-full h-full max-h-[200px] pointer-events-none rounded-lg"
            :viewBox="`0 0 ${previewNaturalDims.w} ${previewNaturalDims.h}`"
            preserveAspectRatio="xMidYMid meet"
          >
            <circle
              :cx="lensFocusPoint.x * previewNaturalDims.w"
              :cy="lensFocusPoint.y * previewNaturalDims.h"
              :r="Math.max(previewNaturalDims.w, previewNaturalDims.h) * 0.02"
              fill="none"
              stroke="#fbbf24"
              stroke-width="3"
              vector-effect="non-scaling-stroke"
            />
          </svg>
        </div>
      </template>
    </div>

    <!-- Takes strip (flag-gated): switch / pin / discard this node's results -->
    <TakesStrip
      v-if="(data.takes?.length ?? 0) >= 1"
      :takes="data.takes!"
      :active-take-id="data.activeTakeId"
      @select="selectTake"
      @pin="pinTake"
      @discard="discardTake"
      @expand="lightTableOpen = true"
    />

    <LightTableModal
      v-if="lightTableOpen"
      :takes="data.takes ?? []"
      :active-take-id="data.activeTakeId"
      :title="data.title || 'Takes'"
      :promote-usd-label="null"
      @select="selectTake"
      @pin="pinTake"
      @discard="discardTake"
      @branch="branchFromTake"
      @discard-others="onDiscardOthers"
      @close="lightTableOpen = false"
    />

    <!-- Per-node run control (footer): one split button. The main face runs
         THIS node with upstream cached (Play → Re-render after first run); the
         caret opens the two scope variants. See playThisNode / runFromStart /
         runDownstream. -->
    <!-- The run bar's corners are 3px, not the 4px they started at, so they are CONCENTRIC
         with the card: inner radius = outer radius - padding = 13 - 10. At 4px the arcs sat
         1.4px apart and diagonal clearance at a corner fell to ~7.6px against 10px on the
         flats. The bottom is the only edge with a card corner at each end, so that pinch
         read as "the bottom margin is smaller" when all three margins measure 10px. -->
    <div v-if="showRunButton" ref="runMenuRoot" class="relative px-2.5 pb-2.5">
      <div class="flex items-stretch gap-px">
        <button
          class="nopan nodrag flex-1 h-9 rounded-l-[6px] flex items-center justify-center gap-2 text-[11px] font-medium transition-[transform,background-color,color] active:scale-[0.96] cursor-pointer"
          :class="(isMuted || isBypassed)
            ? 'bg-white/[0.04] text-white/25 cursor-not-allowed active:scale-100'
            : data.running
              ? 'bg-white/15 text-white active:scale-100'
              : 'bg-white/90 text-neutral-900 hover:bg-white'"
          :disabled="isMuted || isBypassed || data.running"
          :title="isMuted ? 'Node is muted'
            : isBypassed ? 'Node is bypassed'
            : data.running ? 'Running…'
            : hasRun ? 'Re-render this node — new seed, everything upstream stays cached'
            : 'Run this node — upstream stays cached'"
          @click.stop="playThisNode"
        >
          <Loader2 v-if="data.running" class="size-3 animate-spin" />
          <RefreshCw v-else-if="hasRun" class="size-3" />
          <Play v-else class="size-3" />
          <span>{{ data.running ? 'Running…' : hasRun ? 'Re-render' : 'Play' }}</span>
        </button>
        <button
          aria-label="Run scope options"
          class="nopan nodrag w-9 h-9 rounded-r-[6px] flex items-center justify-center transition-colors cursor-pointer"
          :class="(isMuted || isBypassed || data.running)
            ? 'bg-white/[0.04] text-white/25 cursor-not-allowed'
            : 'bg-white/90 text-neutral-900 hover:bg-white'"
          :disabled="isMuted || isBypassed || data.running"
          @click.stop="runMenuOpen = !runMenuOpen"
        >
          <ChevronDown class="size-3 transition-transform" :class="runMenuOpen ? 'rotate-180' : ''" />
        </button>
      </div>

      <!-- Scope menu — opens upward so it isn't clipped at the node's bottom. -->
      <div
        v-if="runMenuOpen"
        class="absolute left-2.5 right-2.5 bottom-full mb-1 z-50 rounded-lg border border-white/10 bg-neutral-900/95 backdrop-blur-md p-1 shadow-xl"
      >
        <button class="nopan nodrag w-full text-left rounded-[6px] px-2 py-1.5 flex gap-2 items-start hover:bg-white/[0.06] cursor-pointer" @click.stop="playThisNode">
          <RefreshCw class="size-3.5 mt-0.5 text-white/80 shrink-0" />
          <span class="min-w-0">
            <span class="block text-[11px] font-medium text-white/90">Run this node</span>
            <span class="block text-[10px] text-white/45 leading-snug">Re-render this node, upstream stays cached</span>
          </span>
        </button>
        <button v-if="directExecutionEnabled" class="nopan nodrag w-full text-left rounded-[6px] px-2 py-1.5 flex gap-2 items-start hover:bg-white/[0.06] cursor-pointer" @click.stop="rerollTakesParallel">
          <Layers class="size-3.5 mt-0.5 text-white/80 shrink-0" />
          <span class="min-w-0">
            <span class="block text-[11px] font-medium text-white/90">Re-render ×4 (parallel)</span>
            <span class="block text-[10px] text-white/45 leading-snug">Four fresh takes at once across the cloud pool</span>
          </span>
        </button>
        <button class="nopan nodrag w-full text-left rounded-[6px] px-2 py-1.5 flex gap-2 items-start hover:bg-white/[0.06] cursor-pointer" @click.stop="runFromStart">
          <SkipBack class="size-3.5 mt-0.5 text-white/60 shrink-0" />
          <span class="min-w-0">
            <span class="block text-[11px] font-medium text-white/90">Rebuild from start → here</span>
            <span class="block text-[10px] text-white/45 leading-snug">Fresh run of everything before, new seeds</span>
          </span>
        </button>
        <button class="nopan nodrag w-full text-left rounded-[6px] px-2 py-1.5 flex gap-2 items-start hover:bg-white/[0.06] cursor-pointer" @click.stop="runDownstream">
          <SkipForward class="size-3.5 mt-0.5 text-white/60 shrink-0" />
          <span class="min-w-0">
            <span class="block text-[11px] font-medium text-white/90">Run here → end</span>
            <span class="block text-[10px] text-white/45 leading-snug">Push this result through everything after</span>
          </span>
        </button>
      </div>
    </div>
  </div>
  </Transition>
  </div>
</template>

<style scoped>
.comfy-node {
  /* `backdrop-blur-sm` removed: the card's background is set inline and has always been
     opaque, so there was never anything to see through it — the filter ran every frame
     and changed nothing.

     16px. It matches the capsule, so the corner does not change shape halfway through
     the expand, and 16 - 10 inset = 6 is the radius every input and button uses — so the
     corners stay concentric and the bottom does not pinch against the run bar. The 6px
     came first here: it is the app-wide control radius, and the shell was set to suit
     it. (History: 13 = 7 + 6, then 16/8, then 12/4 which read too sharp, then 14/6,
     now 16/10/6 — the inset went to 10 for the roomier spacing, so the shell followed.)
     See NodeCapsule.vue, which must stay equal. */
  border-radius: 16px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 1px 4px rgba(0, 0, 0, 0.2);
}
.node-head {
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
}

/* The header's icon and title sit at exactly the capsule's offsets — 7px in,
   a 26px tile, a 9px gap — so expanding leaves both of them where they were and
   the card grows around a header that does not move. Layout lives here rather
   than in utilities so the two components can be read against each other. */
.node-head {
  gap: 10px;
  padding: 10px 12px 10px 10px;
}
.node-head__tile {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.72);
}
.node-head__tile :is(svg, img) { width: 15px; height: 15px; display: block; }

/* A truncated title tells you a node is "Generate an i…". On hover the full
   text tracks past and comes back, so the ellipsis stops being a dead end. */
.node-head__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.node-head__title > span {
  display: inline-block;
  white-space: nowrap;
}
.comfy-node:hover .node-head__title > span {
  animation: node-title-ticker var(--tick-dur, 0s) ease-in-out infinite alternate;
}
@keyframes node-title-ticker {
  from { translate: 0; }
  to { translate: var(--tick-shift, 0px); }
}

/* Capsule <-> card. NOT a cross-fade — fading one out while fading the other
   in reads as two different objects swapping places. This has to read as one
   object opening.
   The header is pixel-identical between the two (icon and title both at y=20,
   x=8 and x=43) and the widths match, so nothing about the top of the node
   needs to animate: that swap happens in a single frame and is invisible. What
   animates is the card's real HEIGHT, which is what makes the ports and their
   wires travel with it — an earlier clip-path version looked the same but does
   not affect layout, so the ports sat at their final positions from frame one
   and the edges snapped.
   Start and end heights are measured and set inline by the hooks above; CSS has
   no height to animate to. One rule set covers both directions. */
.capsule-swap-enter-active,
.capsule-swap-leave-active {
  transition-property: height, opacity;
  transition-timing-function: cubic-bezier(0.32, 0, 0.12, 1);
  /* Compositing a backdrop filter every frame while the element is clipped is
     the expensive part, and the blur is invisible mid-transition anyway. */
  backdrop-filter: none;
}
.capsule-swap-enter-active { transition-duration: 0.36s; }
.capsule-swap-leave-active {
  transition-duration: 0.22s;
  position: absolute;
  top: 0;
  left: 0;
}
/* The CARD fades, the capsule does not. Both elements pass through these
   classes, so the opacity is scoped with :not(.node-capsule) — the capsule
   carries `comfy-node` too, for the selection outline, so the capsule class is
   what actually tells them apart. Holding the capsule at full opacity is what
   keeps the header looking continuous: it is pixel-identical to the card's, so
   fading it would draw attention to a swap that is otherwise invisible.

   Still no scale. Once the capsule and the card share a width, ANY scale
   reintroduces horizontal movement — 0.97 started the card ~8px narrower than
   the capsule it replaced, which reads as growing out of something smaller. */
.capsule-swap-enter-from:not(.node-capsule),
.capsule-swap-leave-to:not(.node-capsule) { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .capsule-swap-enter-active,
  .capsule-swap-leave-active { transition-duration: 1ms; }
  .comfy-node:hover .node-head__title > span { animation: none; }
}

/* Collapsed: every port sits at the capsule's vertical centre, so edges
   converge on one point per side instead of trailing off a 40px chip. They
   stay in the DOM with their handle ids intact — that is what keeps the
   edges attached. Non-interactive because you cannot meaningfully aim at
   four overlapping dots; expand the node to rewire it. */
.comfy-node-collapsed .node-port {
  top: 50% !important;
  margin-top: -8px !important;
  opacity: 0;
  pointer-events: none;
}

/* Outpaint zone preview: dark base + blue diagonal hatch marks the new area,
   dashed edge marks the expanded canvas. The original thumbnail sits on top. */
.op-canvas {
  box-sizing: border-box;
  background-color: #161d33;
  background-image: repeating-linear-gradient(
    45deg, transparent 0 5px, rgba(91, 123, 214, 0.55) 5px 6px);
  border: 1px dashed rgba(91, 123, 214, 0.8);
}

/* Sweeping glow border when running */
.comfy-node[data-running] {
  --border-left: var(--border-color-left, #fff);
  --border-right: var(--border-color-right, #fff);
  box-shadow:
    0 4px 16px rgba(0, 0, 0, 0.4),
    0 1px 4px rgba(0, 0, 0, 0.2);
  border-color: transparent;
}

.comfy-node[data-running]::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  padding: 2px;
  /* Static positional color: input color on left, output color on right */
  background: linear-gradient(to right, var(--border-left), var(--border-right));
  /* Three-layer mask: sweep visibility ∩ border ring */
  -webkit-mask:
    conic-gradient(from var(--sweep-angle), transparent 0%, white 6%, white 18%, transparent 26%),
    linear-gradient(white 0 0) content-box,
    linear-gradient(white 0 0);
  -webkit-mask-composite: source-in, xor;
  mask:
    conic-gradient(from var(--sweep-angle), transparent 0%, white 6%, white 18%, transparent 26%),
    linear-gradient(white 0 0) content-box,
    linear-gradient(white 0 0);
  mask-composite: intersect, exclude;
  animation: border-sweep 2s linear infinite;
  pointer-events: none;
  z-index: -1;
}

/* Muted: dimmed + desaturated. Skipped at execution time. */
.comfy-node--muted {
  opacity: 0.45;
  filter: grayscale(0.8);
}

/* Bypassed: pass-through. Faint amber accent + striped overlay rendered above. */
.comfy-node--bypassed {
  opacity: 0.85;
  border-style: dashed;
  border-color: rgba(251, 191, 36, 0.35);
}

.comfy-node-stripes {
  background-image: repeating-linear-gradient(
    -45deg,
    rgba(251, 191, 36, 0.06) 0,
    rgba(251, 191, 36, 0.06) 6px,
    transparent 6px,
    transparent 14px
  );
}
</style>
