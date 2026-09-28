<script setup lang="ts">
import { Loader2, Image as ImageIcon, ImagePlus, Play, Download, Lock, Brush, Drama } from 'lucide-vue-next'
import { onClickOutside } from '@vueuse/core'
import { getTypeColor } from '~/composables/useVueNodes'
import NodeRunRow from '~/components/vue-canvas/NodeRunRow.vue'
import NodeFixesBadge from '~/components/vue-canvas/NodeFixesBadge.vue'
import ContentCard from '~/components/vue-canvas/surfaces/ContentCard.vue'
import NodeMoreMenu, { type MoreItem } from '~/components/vue-canvas/surfaces/NodeMoreMenu.vue'
import { runRowStatus } from '~/lib/canvas/runRowStatus'
import { useRunRowClock } from '~/composables/useRunRowClock'
import { useAgentActivity } from '~/composables/useAgentActivity'
import { useImgFx } from '~/composables/useImgFx'
import TakesStrip from '~/components/vue-canvas/TakesStrip.vue'
import LightTableModal from '~/components/vue-canvas/LightTableModal.vue'
import RefNameDialog from '~/components/vue-canvas/RefNameDialog.vue'
import { useNextStepsStrip } from '~/composables/useNextStepsStrip'
import { projectTake, discardOthers, type Take } from '~/composables/useTakes'
import { uploadRefFile } from '~/lib/shotdirector/refUpload'
import { useCharacters } from '~/composables/useCharacters'
import { setPendingPromote } from '~/lib/draft/runMeta'
import { promoteOverridesFor } from '~/lib/draft/promote'
import { annotatedImageValueFromViewUrl } from '~/lib/promoteTempImages'
import { parseBadgeUsd } from '~/lib/costEstimate'
import { formatCostBadge } from '~/lib/pricing'
import { hostedModeEnabled } from '~/lib/hostedMode'
import { toast } from 'vue-sonner'

// The visual half of the unified `Image` artifact node. State is derived from
// (upstream connection, file widget, execution output) rather than the node
// type — there's only one node type now, behaving like Load / Preview / Save
// depending on what the user wires and toggles.
const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    nodeType: string
    title: string
    inputs: { name: string; type: string; link: number | null }[]
    outputs: { name: string; type: string; links: number[] | null }[]
    widgetsValues: any[]
    widgetDefs?: any[]
    mode: number
    running?: boolean
    error?: boolean
    lastRunAt?: number | null
    images?: string[]
    outputNode?: boolean
    // Takes (non-destructive variation loop) — flag-gated, additive.
    takes?: Take[]
    activeTakeId?: string | null
    properties?: Record<string, unknown>
  }
}>()

const isMuted = computed(() => props.data.mode === 2)
const isBypassed = computed(() => props.data.mode === 4)

const imageColor = computed(() => getTypeColor('IMAGE'))

// The agent is reviewing THIS node → show the white scanning overlay.
const { analyzingNodeIds } = useAgentActivity()
const { patchState } = useCharacters()
const isAnalyzing = computed(() => analyzingNodeIds.value.has(props.id))

// Vue Flow injects nodes/edges so we can ask "is anything wired to my image
// input right now?" — `inputs[i].link` lags behind in-session connections.
const injectedEdges = inject<any>('vueFlowEdges', null)
// Leaves (terminal outputs) of the active run — see VueNodeCanvas' provide.
const injectedRunLeaves = inject<any>('runLeafNodeIds', null)

// Port indices by name — robust against schema reordering.
function inputIdx(name: string): number {
  return props.data.inputs?.findIndex(i => i.name === name) ?? -1
}
function outputIdx(name: string): number {
  return props.data.outputs?.findIndex(o => o.name === name) ?? -1
}
function widgetIdx(name: string): number {
  return props.data.widgetDefs?.findIndex((w: any) => w.name === name) ?? -1
}

const imagesInIdx = computed(() => inputIdx('images'))
const imageOutIdx = computed(() => outputIdx('image'))
const maskOutIdx = computed(() => outputIdx('mask'))

const imageWidgetIdx = computed(() => widgetIdx('image'))

const widgetFilename = computed<string>(() => {
  const i = imageWidgetIdx.value
  return i >= 0 ? (props.data.widgetsValues?.[i] || '') : ''
})

// "Is something wired into my images input right now?"
const hasUpstream = computed(() => {
  const idx = imagesInIdx.value
  if (idx < 0) return false
  if (props.data.inputs?.[idx]?.link != null) return true
  const edges = injectedEdges?.value ?? []
  return edges.some((e: any) => e.target === props.id && e.targetHandle === `input-${idx}`)
})

// "Is my upstream generator running right now?" VueNodeCanvas lights
// `edge.data.running` on every edge leaving the executing node, so an incoming
// edge with running=true means the node feeding us is mid-generation. Also true
// if this node itself is executing (output sinks that run).
const upstreamRunning = computed(() => {
  // Generation FX (the img-fx churn/dither AND the glimm sweep) belong on the
  // run's OUTPUT nodes only — never on cards that merely FEED the running node.
  // Two gates:
  //  1. hasUpstream — a pure source card (uploaded image) still gets an
  //     'executing' event (ComfyUI loads it) but produces no fresh result.
  //  2. runLeafNodeIds — an INTERMEDIATE result (e.g. BlendScene's output
  //     feeding Relight while Relight runs) is inside the run's keep-set and
  //     its upstream may re-execute, but it isn't the run's terminal output;
  //     churning it reads as "this image is being replaced" when it isn't.
  //     Empty set = no run tracking (legacy path) → no filtering, old behavior.
  if (!hasUpstream.value) return false
  const leaves = injectedRunLeaves?.value
  if (leaves && leaves.size && !leaves.has(String(props.id))) return false
  if (props.data.running) return true
  const edges = injectedEdges?.value ?? []
  return edges.some((e: any) => e.target === props.id && e.data?.running)
})

// Glimm "prism" sweep overlay while generating — same effect the Frame modal
// shows during a generative fill. Created lazily on the overlay canvas, driven
// by a rAF loop only while upstreamRunning, and torn down when it stops.
const sweepCanvas = ref<HTMLCanvasElement | null>(null)
let sweepCtrl: any = null
let sweepCreating = false
let sweepRaf = 0
let sweepStart = 0
const SWEEP_PERIOD = 1.6   // seconds per prism cycle
const SWEEP_ALPHA = 0.6    // peak band opacity
function ensureSweepCtrl() {
  if (sweepCtrl || sweepCreating) return
  const cv = sweepCanvas.value
  if (!cv || cv.clientWidth < 1 || cv.clientHeight < 1) return
  sweepCreating = true
  import('glimm').then(({ createShader, resolvePalette }) => {
    sweepCreating = false
    if (sweepCtrl || !sweepCanvas.value) return
    sweepCtrl = createShader({ canvas: sweepCanvas.value, palette: resolvePalette('citrus'), brightness: 0.85, swellAmount: 0.7 })
  }).catch(() => { sweepCreating = false })
}
function destroySweepCtrl() {
  sweepCtrl?.destroy?.()
  sweepCtrl = null
  sweepCreating = false
}
function tickSweep() {
  sweepRaf = requestAnimationFrame(tickSweep)
  if (!upstreamRunning.value) return
  ensureSweepCtrl()
  if (!sweepCtrl) return
  const tt = (performance.now() - sweepStart) / 1000
  sweepCtrl.setProgress((tt % SWEEP_PERIOD) / SWEEP_PERIOD)
  sweepCtrl.setAlpha(SWEEP_ALPHA)
}
watch(upstreamRunning, (on) => {
  if (on) {
    sweepStart = performance.now()
    if (!sweepRaf) sweepRaf = requestAnimationFrame(tickSweep)
  } else {
    if (sweepRaf) { cancelAnimationFrame(sweepRaf); sweepRaf = 0 }
    destroySweepCtrl()
  }
}, { immediate: true })
onUnmounted(() => {
  if (sweepRaf) cancelAnimationFrame(sweepRaf)
  destroySweepCtrl()
})

// ── img-fx "image generation" reveal (under the glimm sweep) ────────────────
// While the upstream generator runs, the node shows img-fx's churning pixel-cell
// field. Any existing image dissolves INTO the churn (boil); the new result
// dissolves OUT of it (reveal). Lazy: the GL context is created on the first
// generation and released once the reveal settles. Degrades to just the glimm
// sweep if WebGL is unavailable. See useImgFx / image.jakubantalik.com.
// The media "stage" — the image / placeholder region only, NOT the footer
// toolbar below it. The fx canvases live inside this and size to it, so the
// churn/reveal covers just the image (never the toolbar).
const stageRef = ref<HTMLElement | null>(null)
const shaderFxCanvas = ref<HTMLCanvasElement | null>(null)
const revealFxCanvas = ref<HTMLCanvasElement | null>(null)
const fxActive = ref(false)
const fxCardBg = ref('#0f0f0f')   // solid surface behind the mosaic → full-opaque dither
const fx = useImgFx()
const FX_PRESET = 'pixels-organic' as const
let fxFinishing = false   // generation stopped; settle as soon as a reveal lands
let fxRevealing = false   // a result reveal is mid-flight
let fxSettleTimer: ReturnType<typeof setTimeout> | undefined
let fxDisposeTimer: ReturnType<typeof setTimeout> | undefined

function clearSettle() {
  if (fxSettleTimer) { clearTimeout(fxSettleTimer); fxSettleTimer = undefined }
}

function startFx() {
  const stage = stageRef.value, sc = shaderFxCanvas.value, rc = revealFxCanvas.value
  if (!stage || !sc || !rc) return
  clearSettle()
  // A new generation cancels any pending teardown from the last one (fast
  // re-rolls) so we never dispose the fx mid-run.
  if (fxDisposeTimer) { clearTimeout(fxDisposeTimer); fxDisposeTimer = undefined }
  fxFinishing = false
  if (!fx.isMounted()) fx.mount(sc, rc, stage, { preset: FX_PRESET, theme: 'dark' })
  else fx.reset()   // reused across re-rolls: drop the previous held image → clean idle churn
  fxCardBg.value = fx.cardBg()
  fx.churn()
  const prev = displayedUrl.value
  if (prev) {
    // Dissolve the CURRENTLY shown image into the churn. Keep the fx hidden until
    // the old image is HELD, so the node's <img> stays visible up to that moment
    // and the churn never flashes before the image breaks apart.
    fx.boilFrom(prev, () => { fxActive.value = true })
    // Fallback: reveal the fx anyway if the boil seed stalls or the result races in.
    window.setTimeout(() => { fxActive.value = true }, 300)
  } else {
    fxActive.value = true   // no prior image: just show the churn
  }
}

function teardownFx() {
  clearSettle()
  fxFinishing = false
  if (!fxActive.value) return
  fxActive.value = false                       // opacity fade out (260ms)
  if (fxDisposeTimer) clearTimeout(fxDisposeTimer)
  // IDLE, don't dispose: img-fx tears down its shared WebGL renderer when the
  // last instance is disposed, so disposing per generation kills the effect on
  // the next re-roll. Keep the instance mounted+paused; dispose only on unmount.
  fxDisposeTimer = setTimeout(() => { fx.idle(); fxDisposeTimer = undefined }, 300)
}

async function revealFxResult(url: string) {
  if (!fx.isMounted()) return
  fxRevealing = true
  try { await fx.revealResult(url) } finally { fxRevealing = false }
  if (fxFinishing) teardownFx()   // reveal done + generation over → settle now
}

// Same trigger as the glimm sweep. Crucially, when generation STOPS we always
// schedule a bounded settle — the glimm sweep tears down unconditionally here,
// and so must the churn. (Previously teardown was gated on the reveal promise;
// a stalled/absent reveal left the dither running forever after generation.)
watch(upstreamRunning, (on) => {
  if (!import.meta.client) return
  if (on) { startFx(); return }
  if (!fxActive.value) return
  fxFinishing = true
  // Let an in-flight reveal finish its dissolve, but ALWAYS fade out within a
  // bounded window. A landing reveal tears down early via revealFxResult().
  clearSettle()
  fxSettleTimer = setTimeout(teardownFx, fxRevealing ? 3500 : 500)
})

onUnmounted(() => { clearSettle(); if (fxDisposeTimer) clearTimeout(fxDisposeTimer); fx.dispose() })

// Image URL — execution output wins, falling back to the file widget. When
// upstream is connected but the node hasn't run yet, this returns null (we
// show a "render to see preview" state).
const imageUrl = computed<string | null>(() => {
  if (props.data.images?.length) return props.data.images[0]!
  if (!hasUpstream.value && widgetFilename.value) {
    return `/view?${new URLSearchParams({ filename: widgetFilename.value, type: 'input' })}`
  }
  return null
})

// A fresh output landing mid-generation dissolves in over the churn.
// (Registered after the imageUrl declaration above — watching it earlier is a
// use-before-declare crash — and before the preload watcher below so the fx
// reveal starts ahead of the displayedUrl commit.)
watch(imageUrl, (url, prev) => {
  if (!import.meta.client) return
  if (url && url !== prev && fxActive.value) revealFxResult(url)
})

// Lag the rendered <img> by one preload so cache-busting URLs don't flash
// white between updates.
const displayedUrl = ref<string | null>(null)
// Natural pixel dimensions of the shown image (e.g. "1024 × 1024"), captured
// during preload and displayed in the footer in place of the filename.
const dims = ref<string | null>(null)
let preloadGen = 0
watch(imageUrl, (url) => {
  if (!url) { displayedUrl.value = null; dims.value = null; return }
  const mine = ++preloadGen
  const img = new window.Image()
  const commit = () => {
    if (mine !== preloadGen) return
    displayedUrl.value = url
    dims.value = img.naturalWidth > 0 ? `${img.naturalWidth} × ${img.naturalHeight}` : null
  }
  img.onload = commit
  img.onerror = commit
  img.src = url
}, { immediate: true })

const filenameLabel = computed<string | null>(() => {
  if (widgetFilename.value) return widgetFilename.value
  const url = displayedUrl.value
  if (!url) return null
  const m = url.match(/[?&]filename=([^&]+)/)
  if (m && m[1]) {
    try { return decodeURIComponent(m[1]) } catch { return m[1] }
  }
  return null
})

// Loading state: we HAVE a source (e.g. an asset just tapped onto the canvas, or a
// take switch) but the preload above hasn't committed displayedUrl yet — the full
// image is still downloading. Show a spinner instead of the empty upload affordance,
// which otherwise flashes for however long the fetch takes (seconds, for big files).
const loadingImage = computed(() => !!imageUrl.value && !displayedUrl.value)
// Empty state: no image, no upstream — show upload affordance.
// Waiting state: upstream wired, no image yet — show render button.
const showUpload = computed(() => !displayedUrl.value && !hasUpstream.value && !loadingImage.value)
const showRender = computed(() => !displayedUrl.value && hasUpstream.value && !loadingImage.value)

// Upload — same /upload/image endpoint everything else uses.
const fileInputRef = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

async function uploadFile(file: File) {
  uploading.value = true
  try {
    const fd = new FormData()
    fd.append('image', file)
    fd.append('overwrite', 'true')
    const res = await fetch('/upload/image', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`upload returned ${res.status}`)
    const json = await res.json()
    const name = json?.name ?? file.name
    const idx = imageWidgetIdx.value
    if (idx >= 0 && props.data.widgetsValues) {
      props.data.widgetsValues[idx] = name
    }
    const def = props.data.widgetDefs?.find((d: any) => d.name === 'image')
    if (def && Array.isArray(def.options) && !def.options.includes(name)) {
      def.options.push(name)
    }
  } catch (err) {
    console.error('[ArtifactImage] upload failed:', err)
  } finally {
    uploading.value = false
  }
}

async function onFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) await uploadFile(file)
  target.value = ''
}

// A drop replaces the asset whenever it's local and unlocked (empty or already
// loaded) — upstream-fed/locked nodes ignore a dropped file.
const canReplace = computed(() => !hasUpstream.value && !isLocked.value)
function onDrop(event: DragEvent) {
  if (!canReplace.value) return
  event.preventDefault()
  const file = event.dataTransfer?.files?.[0]
  if (file) uploadFile(file)
}
function onDragOver(event: DragEvent) {
  if (!canReplace.value) return
  event.preventDefault()
}

function triggerUpload() {
  fileInputRef.value?.click()
}

// Open the dedicated inpaint editor for this image (the canvas owns the modal).
function openInpaint() {
  window.dispatchEvent(new CustomEvent('sailor:openInpaint', { detail: { nodeId: props.id } }))
}

// OUTPUT_NODE nodes get a per-node Run affordance — the existing event the
// canvas listens for. We surface it as a fallback in the waiting state, in
// the hover chrome, and as the Run row's ▶ under the result.
function runThisNode() {
  if (isMuted.value || isBypassed.value || props.data.running) return
  window.dispatchEvent(
    new CustomEvent('sailor:runFiltered', { detail: { targetIds: [props.id], rerollScope: 'self' } }),
  )
}

// The Run row under the result (spec §2.3): the media is here, so it has
// rendered — the row says when, or that the last run failed, or that it's
// running again. Only shown with something upstream to re-run.
const runRowNow = useRunRowClock()
const runStatus = computed(() => runRowStatus({
  running: !!props.data.running,
  error: !!props.data.error,
  hasRun: true,
  lastRunAt: props.data.lastRunAt ?? null,
  now: runRowNow.value,
}))

// Promote: re-run a draft take's exact snapshot at full quality (spec
// §Promote). Registers the pending promote BEFORE firing the same self-scope
// rerun runThisNode uses; runVueWorkflow substitutes the snapshot's widgets
// into this node's run-path copy, winning over draft mode for this run.
function promoteTake(takeId: string) {
  const take = (props.data.takes ?? []).find((t: any) => t.id === takeId)
  const overrides = take ? promoteOverridesFor(take) : null
  if (!take || !overrides) return
  setPendingPromote(String(props.id), { fromTakeId: take.id, overrides })
  window.dispatchEvent(
    new CustomEvent('sailor:runFiltered', { detail: { targetIds: [props.id], rerollScope: 'self' } }),
  )
}

// Branch a generator off this image (the canvas owns the graph mutation; we
// just announce intent). Only Edit text… uses it here now; the toolbar's
// actions fire the same event from nodeActions.ts.
function spliceEffect(nodeType: string, opts: { run?: boolean; focus?: boolean; branch?: boolean } = {}, widgetOverrides?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent('sailor:applyEffect', {
    detail: { nodeId: props.id, nodeType, output: 'IMAGE', widgetOverrides, ...opts },
  }))
}
// Save the current image as a character in the registry (phase 1: image-only,
// refs are stored in the input dir as /view URLs to avoid JSON bloat).
const savingAsCharacter = ref(false)
async function saveAsCharacter() {
  const src = (props.data as any)?.images?.[0]
  if (!src) return
  const name = window.prompt('Character name')?.trim()
  if (!name) return
  savingAsCharacter.value = true
  try {
    const blob = await (await fetch(src)).blob()
    const refUrl = await uploadRefFile(new File([blob], 'character.png', { type: blob.type || 'image/png' }))
    const filename = new URLSearchParams(refUrl.split('?')[1]).get('filename')!
    const created = await fetch('/api/characters-local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    })
    if (!created.ok) throw new Error(`create ${created.status}`)
    const { slug } = await created.json() as { slug: string }
    // This seeds the Default state's legacy free-form ref POOL (not the
    // Higgsfield `panels`/`sheetImage` composite — this node saves a single
    // photo, not a generated sheet), via the same statePatch path every
    // other per-state mutation now uses.
    const result = await patchState(slug, { stateId: 'default', patch: { refImages: [filename], coverIndex: 0 } })
    if (result !== 'ok') {
      // Don't leave an orphan zero-ref character behind.
      await fetch('/api/characters-local', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, remove: true }),
      }).catch(() => {})
      throw new Error(`attach ref (${result})`)
    }
    toast.success(`Saved ${name} to characters`, { description: 'Castable in the Shot Director' })
  } catch (e) {
    console.warn('[saveAsCharacter]', e)
    toast.error(`Couldn't save ${name} as a character — try again`)
  } finally {
    savingAsCharacter.value = false
  }
}

// `@` promote — name the currently-displayed image as a reusable @ref (see
// docs/superpowers/specs/2026-07-06-named-image-references-design.md). The
// registered filename must live in the ComfyUI *input* dir so downstream
// consumers (bind-by-name image widgets, materialized Reference nodes) can load
// it, so we upload the displayed image the same way saveAsCharacter does and
// register the returned input-dir filename. The layout (default.vue) owns the
// registry write via the `sailor:createRef` event, keeping this node decoupled
// from the project doc.
const refDialogOpen = ref(false)
const creatingRef = ref(false)
function openRefDialog() { if (displayedUrl.value) refDialogOpen.value = true }
async function onRefConfirm(name: string, text: string) {
  refDialogOpen.value = false
  const src = displayedUrl.value
  if (!src) return
  creatingRef.value = true
  try {
    const blob = await (await fetch(src)).blob()
    const refUrl = await uploadRefFile(new File([blob], `${name}.png`, { type: blob.type || 'image/png' }))
    const filename = new URLSearchParams(refUrl.split('?')[1]).get('filename')!
    window.dispatchEvent(new CustomEvent('sailor:createRef', {
      detail: { name, entry: { filename, text: text || undefined } },
    }))
  } catch (e) {
    console.warn('[createRef]', e)
    toast.error(`Couldn't create @${name} — try again`)
  } finally {
    creatingRef.value = false
  }
}

// Hover reveals the chrome strip over the image.
const rootEl = ref<HTMLElement | null>(null)

// ── Edit text popover — find/replace fields, spawns a TextEditNode ───────────
// Opened from the node toolbar's Edit ▾ → "Edit text…" (nodeActions fires
// `sailor:openTextEdit`); positioned beside this node's root.
const textEditOpen = ref(false)
const textEditPanelRef = ref<HTMLElement | null>(null)
const textEditStyle = ref<Record<string, string>>({})
const textFind = ref('')
const textReplace = ref('')
onClickOutside(textEditPanelRef, () => { textEditOpen.value = false })

function openTextEdit() {
  textEditStyle.value = menuStyleFor((rootEl.value as any)?.$el ?? null)
  textFind.value = ''
  textReplace.value = ''
  textEditOpen.value = true
}
function onOpenTextEdit(e: Event) {
  if ((e as CustomEvent<{ nodeId?: string }>).detail?.nodeId === props.id) openTextEdit()
}
onMounted(() => window.addEventListener('sailor:openTextEdit', onOpenTextEdit))
onBeforeUnmount(() => window.removeEventListener('sailor:openTextEdit', onOpenTextEdit))

function runTextEdit() {
  if (!textFind.value.trim() || !textReplace.value.trim()) return
  spliceEffect('TextEditNode', { run: true, branch: true }, { find: textFind.value.trim(), replace: textReplace.value.trim() })
  textEditOpen.value = false
}

// Beside the node's right edge, top-aligned with the anchor; flips to the
// node's left when the viewport runs out. Vertical position clamps so the panel
// always fits, scrolling internally as a last resort on short viewports.
function menuStyleFor(anchor: HTMLElement | null): Record<string, string> {
  const nodeR = (anchor?.closest('.artifact-image') as HTMLElement | null)?.getBoundingClientRect()
  const btnR = anchor?.getBoundingClientRect()
  if (!nodeR || !btnR) return {}
  const MENU_W = 230
  const MENU_H = 160
  const left = nodeR.right + 8 + MENU_W <= window.innerWidth
    ? nodeR.right + 8
    : Math.max(8, nodeR.left - 8 - MENU_W)
  const top = Math.max(8, Math.min(btnR.top, window.innerHeight - MENU_H - 8))
  return { left: `${left}px`, top: `${top}px`, maxHeight: `${window.innerHeight - top - 8}px` }
}
// Pan/zoom would leave the fixed panel floating at a stale spot — close instead.
function closeTextEditOnWheel() { textEditOpen.value = false }
watch(textEditOpen, (open) => {
  if (open) window.addEventListener('wheel', closeTextEditOnWheel, { passive: true })
  else window.removeEventListener('wheel', closeTextEditOnWheel)
})
onBeforeUnmount(() => window.removeEventListener('wheel', closeTextEditOnWheel))

// Browser-side download — same blob trick SmartLayout's carousel uses, so the
// saved filename is the real one instead of "view".
async function downloadImage() {
  const url = displayedUrl.value
  if (!url) return
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const obj = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = obj
    a.download = filenameLabel.value || 'image.png'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(obj)
  } catch (err) {
    console.error('[ArtifactImage] download failed:', err)
  }
}

// Lock state: pin this image so upstream re-execution is skipped. We copy
// the current preview into the input directory and point the file widget
// at it; the canvas's workflow-build step then drops incoming edges to
// this node, so collectKeepSet stops walking upstream here.
const isLocked = computed(() => !!(props.data.properties as any)?.locked)
const locking = ref(false)

async function lockArtifact() {
  const url = displayedUrl.value
  if (!url || locking.value) return
  locking.value = true
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const ext = blob.type === 'image/png' ? 'png'
      : blob.type === 'image/jpeg' ? 'jpg'
      : blob.type === 'image/webp' ? 'webp' : 'png'
    // Deterministic name so re-lock doesn't proliferate files.
    const filename = `locked_${props.id}.${ext}`
    const fd = new FormData()
    fd.append('image', new File([blob], filename, { type: blob.type }))
    fd.append('overwrite', 'true')
    const up = await fetch('/upload/image', { method: 'POST', body: fd })
    if (!up.ok) throw new Error(`upload returned ${up.status}`)
    const json = await up.json()
    const name = json?.name ?? filename
    const idx = imageWidgetIdx.value
    if (idx >= 0 && props.data.widgetsValues) {
      props.data.widgetsValues[idx] = name
    }
    const def = props.data.widgetDefs?.find((d: any) => d.name === 'image')
    if (def && Array.isArray(def.options) && !def.options.includes(name)) {
      def.options.push(name)
    }
    if (!props.data.properties) (props.data as any).properties = {}
    ;(props.data.properties as any).locked = true
  } catch (err) {
    console.error('[ArtifactImage] lock failed:', err)
  } finally {
    locking.value = false
  }
}

function unlockArtifact() {
  if (!props.data.properties) return
  ;(props.data.properties as any).locked = false
}

// --- Takes (non-destructive variation loop) --------------------------------
// Outputs materialize into this artifact node, so this is where takes land.
// projectTake mirrors the chosen take onto data.images → imageUrl recomputes.
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
  ;(props.data as any).takes = takes
  if (props.data.activeTakeId === id) {
    const fallback = takes.find((t) => t.pinned) || takes[takes.length - 1] || null
    Object.assign(props.data, projectTake(props.data, fallback))
  }
}
// Writes a takes array + re-projects whichever take should now be active —
// the same write/project mechanism discardTake uses above, generalized so
// discard-others (and its undo) can both go through it.
function setTakes(takes: Take[], activeId: string | null) {
  ;(props.data as any).takes = takes
  const active = takes.find((t) => t.id === activeId) ?? null
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
  // Display fields alone leave the new node's `image` widget empty — runnable
  // only by luck. Recover the annotated filename from the take's /view URL
  // (same shape the executed-output handler builds it in) so the branched
  // node is wired the same as a normal LoadImage reference. A take whose
  // image isn't a /view URL (e.g. a data: URL) has no recoverable filename —
  // in that case we leave it display-only rather than fake a widget value.
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

// Light Table — full-screen compare grid, opened from the strip's expand button.
const lightTableOpen = ref(false)

// --- AI critique fixes (surfaced in the node toolbar's Edit ▾) --------------
// A paid render triggers a quiet critique pass (gate lives in useCanvasPrompt);
// any fixes it finds land on this node's `fixes` channel and lead the toolbar's
// Edit ▾ menu (NodeActionToolbar). Baseline is taken at mount so restoring a saved canvas
// never re-triggers reviews.
const nextSteps = useNextStepsStrip()
watch(() => props.data.takes?.length ?? 0, (now, before) => {
  if (now > (before ?? 0)) {
    // A fresh render invalidates fixes found on the previous one.
    nextSteps.clearFixes(props.id)
    const takeId = props.data.takes?.[props.data.takes.length - 1]?.id
    if (takeId) {
      window.dispatchEvent(new CustomEvent('sailor:autoReview', {
        detail: { nodeId: props.id, takeId: String(takeId) },
      }))
    }
  }
})

// Promote button price hint — this node's own price badge (a promote reruns
// the SAME generator at full quality, so its badge is the right estimate).
const hostedPricing = hostedModeEnabled(useRuntimeConfig().public)
const promoteUsdLabel = computed(() => {
  const cost = parseBadgeUsd((props.data as any)?.priceBadge?.expr)
  return cost ? ` ${formatCostBadge(cost.usd, true, hostedPricing)}` : null
})

// The old hover strip's buttons, now Download (floating, see template) plus
// this More menu — same functions, same guards as the removed buttons.
const moreItems = computed<MoreItem[]>(() => [
  ...(canReplace.value ? [{ label: 'Replace image', onSelect: triggerUpload, disabled: uploading.value }] : []),
  { label: isLocked.value ? 'Unlock' : 'Lock', onSelect: () => (isLocked.value ? unlockArtifact() : lockArtifact()), disabled: locking.value },
  { label: props.data.running ? 'Running…' : 'Re-render', onSelect: runThisNode, disabled: !!props.data.running || isMuted.value || isBypassed.value },
  { label: 'Save as character', onSelect: saveAsCharacter, disabled: savingAsCharacter.value },
  { label: 'Name as reference', onSelect: openRefDialog, disabled: creatingRef.value },
])
</script>

<template>
  <div class="relative w-fit">
    <ContentCard
      ref="rootEl"
      class="artifact-image relative z-10 w-[240px] select-none"
      :class="{
        'artifact-image--muted': isMuted,
        'artifact-image--bypassed': isBypassed,
        'artifact-image--locked': isLocked,
      }"
      :name="filenameLabel || 'Image'"
      :selected="selected"
      :data-running="data.running || undefined"
      :data-error="data.error || undefined"
      :style="{ '--port-color': imageColor } as any"
      @dragover="onDragOver"
      @drop="onDrop"
    >
      <template #meta>
        <span v-if="dims" class="shrink-0 tabular-nums text-white/30">{{ dims }}</span>
      </template>

      <template #ports>
        <!-- Primary IMAGE input — vertically centered on the image frame.
             Conditionally rendered so empty Image nodes don't dangle a port. -->
        <VueCanvasNodePort
          v-if="imagesInIdx >= 0"
          :id="`input-${imagesInIdx}`"
          type="target"
          side="left"
          :data-type="data.inputs?.[imagesInIdx]?.type ?? 'IMAGE'"
          label="Image"
          :index="0"
        />
        <!-- Primary IMAGE output -->
        <VueCanvasNodePort
          v-if="imageOutIdx >= 0"
          :id="`output-${imageOutIdx}`"
          type="source"
          side="right"
          :data-type="data.outputs?.[imageOutIdx]?.type ?? 'IMAGE'"
          label="Image"
          :index="0"
        />
        <!-- Secondary MASK output — was a small port + label row below the frame;
             now the third shared port so the image stays the dominant visual. -->
        <VueCanvasNodePort
          v-if="maskOutIdx >= 0"
          :id="`output-${maskOutIdx}`"
          type="source"
          side="right"
          :data-type="data.outputs?.[maskOutIdx]?.type ?? 'MASK'"
          label="Mask"
          :index="1"
        />
      </template>

      <template #overlay>
        <VueCanvasNodeReadyBadge :node-id="id" />
      </template>

      <!-- Media stage — the image/placeholder region only. The fx + sweep
           overlays live in here and size to it, so the churn/reveal covers just
           the image and never the footer toolbar below. -->
      <div ref="stageRef" class="relative">
      <!-- img-fx "image generation" effect — the churning pixel-cell field and
           per-cell image reveal, layered UNDER the glimm sweep. Existing image
           boils into the churn; the new result dissolves out of it.
           The fade lives on THIS wrapper, not the canvases: img-fx drives each
           canvas's own opacity for its reveal/boil cross-fade, so binding opacity
           on them directly would fight it (the churn wouldn't persist through a
           boil). -->
      <div
        class="absolute inset-0 z-10 pointer-events-none"
        :style="{ opacity: fxActive ? 1 : 0, transition: 'opacity 260ms ease' }"
      >
        <canvas
          ref="shaderFxCanvas"
          class="absolute inset-0 w-full h-full"
          :style="{ background: fxActive ? fxCardBg : 'transparent' }"
        />
        <canvas
          ref="revealFxCanvas"
          class="absolute inset-0 w-full h-full"
        />
      </div>
      <!-- Glimm prism sweep — runs while the upstream generator is active. -->
      <canvas
        ref="sweepCanvas"
        class="absolute inset-0 w-full h-full pointer-events-none z-20"
        :style="{ opacity: upstreamRunning ? 1 : 0, transition: 'opacity 240ms ease' }"
      />
      <!-- Agent "scanning" overlay — runs while the agent reviews THIS node. -->
      <VueCanvasAgentScanOverlay :active="isAnalyzing" />
      <!-- File picker — always mounted so Replace works in any state. -->
      <input
        ref="fileInputRef"
        type="file"
        accept="image/*"
        class="hidden"
        @change="onFileChange"
      />
      <!-- Inpaint affordance for the empty / waiting states (corner button so it
           doesn't fight the big upload/render targets). -->
      <button
        v-if="showUpload || showRender"
        class="nopan nodrag absolute top-1 left-1 z-10 flex items-center gap-1 h-6 px-1.5 rounded bg-black/50 hover:bg-black/70 text-white/55 hover:text-white/70 text-[10px] transition-colors cursor-pointer"
        title="Inpaint — paint a region and describe the change"
        @click.stop="openInpaint"
      >
        <Brush class="size-3" /> Inpaint
      </button>

      <!-- IMAGE PRESENT -->
      <template v-if="displayedUrl">
        <!-- Persistent badges, top-left: Locked (the toggle now lives in the
             card's More menu, but a pinned card must read as pinned without
             hovering) and "N fixes" (always visible; opens Edit ▾). Static
             top-1.5 — the hover toolbar they used to step down for is gone,
             so there's nothing left to dodge. -->
        <div
          class="pointer-events-none absolute left-1.5 top-1.5 z-40 flex items-center gap-1"
        >
          <div
            v-if="isLocked"
            class="flex items-center gap-1 rounded bg-amber-500/20 border border-amber-400/30 px-1.5 py-0.5 text-[9px] font-medium text-amber-200 backdrop-blur-sm"
          >
            <Lock class="size-2.5" /> Locked
          </div>
          <NodeFixesBadge :node-id="id" class="pointer-events-auto" />
        </div>
        <!-- Main image -->
        <img
          :src="displayedUrl"
          class="block w-full max-h-[280px] object-contain bg-black/50"
          loading="lazy"
        />
      </template>

      <!-- LOADING STATE — a source is set but the full image is still downloading
           (e.g. an asset just added from the panel: it's copied to the input folder
           and the full-res /view fetch can take a few seconds). -->
      <template v-else-if="loadingImage">
        <div class="aspect-square flex flex-col items-center justify-center gap-2 text-white/45">
          <Loader2 class="size-7 animate-spin" :stroke-width="1.5" />
          <span class="text-[11px]">Loading…</span>
        </div>
      </template>

      <!-- UPLOAD EMPTY STATE — no upstream, no file yet -->
      <template v-else-if="showUpload">
        <!-- Upload affordance — no nopan/nodrag so click-in-place opens
             the file picker but click-and-drag moves the card. -->
        <button
          class="w-full aspect-square flex flex-col items-center justify-center gap-2 text-white/45 hover:text-white/85 hover:bg-white/[0.04] transition-colors cursor-pointer disabled:opacity-50"
          :disabled="uploading"
          @click="triggerUpload"
        >
          <Loader2 v-if="uploading" class="size-7 animate-spin" />
          <ImagePlus v-else class="size-7" :stroke-width="1.5" />
          <span class="text-[11px]">{{ uploading ? 'Uploading…' : 'Drop or click an image' }}</span>
        </button>
      </template>

      <!-- RENDER STATE — upstream wired, waiting on an execution -->
      <template v-else-if="showRender">
        <div class="aspect-square flex flex-col items-center justify-center gap-2 text-white/35 px-4">
          <ImageIcon class="size-7" :stroke-width="1.5" />
          <template v-if="data.running">
            <Loader2 class="size-4 animate-spin text-white/55" />
            <span class="text-[11px] text-white/55">Rendering…</span>
          </template>
          <template v-else>
            <button
              class="nopan nodrag mt-1 flex items-center gap-1.5 px-3 h-7 rounded bg-white/[0.08] hover:bg-white/[0.15] text-white/75 hover:text-white text-[11px] transition-colors cursor-pointer disabled:opacity-50"
              :disabled="isMuted || isBypassed"
              @click.stop="runThisNode"
            >
              <Play class="size-2.5" fill="currentColor" />
              Render
            </button>
          </template>
        </div>
      </template>
      </div><!-- /media stage -->

      <template #actions>
        <button v-if="displayedUrl" type="button" title="Download" @click.stop="downloadImage">
          <Download class="size-3.5" />
        </button>
        <NodeMoreMenu :items="moreItems" />
      </template>

      <template #below>
        <!-- Run row — where the Edit…/Develop… footer was (Task 8 moved those
             to the node toolbar). Outside the media stage, so the churn/reveal
             never covers it. -->
        <NodeRunRow
          v-if="displayedUrl && hasUpstream"
          :status="runStatus"
          :can-run="!isMuted && !isBypassed"
          :running="!!data.running"
          run-label="Re-render this node"
          @run="runThisNode"
        />

        <!-- Takes strip (flag-gated): switch / pin / discard this node's results -->
        <TakesStrip
          v-if="(data.takes?.length ?? 0) >= 1"
          :takes="data.takes!"
          :active-take-id="data.activeTakeId"
          class="mt-1.5"
          @select="selectTake"
          @pin="pinTake"
          @discard="discardTake"
          @expand="lightTableOpen = true"
          @promote="promoteTake"
        />
      </template>
    </ContentCard>

    <!-- Edit text… find/replace panel, opened from the node toolbar. -->
    <Teleport to="body">
      <div v-if="textEditOpen" ref="textEditPanelRef"
           class="nopan nodrag fixed z-[9999] w-[230px] rounded-md border border-white/10 bg-[#1a1a1a] shadow-lg p-2.5 flex flex-col gap-2"
           :style="textEditStyle">
        <div class="text-[9px] uppercase tracking-wider text-white/30 select-none">Edit text in image</div>
        <input v-model="textFind" placeholder="Text currently in the image" spellcheck="false"
               class="h-7 px-2 rounded bg-white/[0.06] border border-white/10 text-[11px] text-white/85 outline-none focus:border-white/25"
               @keydown.enter.prevent="runTextEdit" />
        <input v-model="textReplace" placeholder="Replace with…" spellcheck="false"
               class="h-7 px-2 rounded bg-white/[0.06] border border-white/10 text-[11px] text-white/85 outline-none focus:border-white/25"
               @keydown.enter.prevent="runTextEdit" />
        <button class="gen-pastel h-7 rounded text-neutral-900 text-[11px] font-semibold cursor-pointer disabled:opacity-40"
                :disabled="!textFind.trim() || !textReplace.trim()" @click="runTextEdit">
          Replace text · ~$0.05
        </button>
      </div>
    </Teleport>

    <!-- Name-as-reference dialog (self-teleports to <body>). -->
    <RefNameDialog :open="refDialogOpen" @confirm="onRefConfirm" @cancel="refDialogOpen = false" />

    <LightTableModal
      v-if="lightTableOpen"
      :takes="data.takes ?? []"
      :active-take-id="data.activeTakeId"
      :title="data.title || 'Takes'"
      :promote-usd-label="promoteUsdLabel"
      @select="selectTake"
      @pin="pinTake"
      @discard="discardTake"
      @promote="promoteTake"
      @branch="branchFromTake"
      @discard-others="onDiscardOthers"
      @close="lightTableOpen = false"
    />
  </div>
</template>

<style scoped>
.artifact-image--muted { opacity: 0.45; filter: grayscale(0.8); }
.artifact-image--bypassed { opacity: 0.85; }
/* Bypassed and locked edges are drawn by a ::before inside the media box, so the
   selection outline and the shared running/failed rings still show on top. */
.artifact-image--bypassed :deep(.content-card__media)::before,
.artifact-image--locked :deep(.content-card__media)::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: 4;
}
.artifact-image--bypassed :deep(.content-card__media)::before {
  border: 1px dashed rgba(251, 191, 36, 0.35);
}
.artifact-image--locked :deep(.content-card__media)::before {
  /* Amber tint to match the seed-lock toggle's visual language — same
     "frozen / pinned" signal across the canvas. */
  box-shadow: inset 0 0 0 1px rgba(251, 191, 36, 0.45);
}
</style>
