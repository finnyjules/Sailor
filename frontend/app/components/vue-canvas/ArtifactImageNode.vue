<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import { Upload, Loader2, Image as ImageIcon, ImagePlus, Play, Download, RefreshCw, Lock, LockOpen, Eraser, Brush, Sparkles, Pencil, Wand2, Drama, Gem, ZoomIn, Lamp, Aperture, Shuffle, Clapperboard, ArrowRight, Scissors, Palette, Paintbrush, Type } from 'lucide-vue-next'
import { onClickOutside } from '@vueuse/core'
import { getTypeColor } from '~/composables/useVueNodes'
import { useAgentActivity } from '~/composables/useAgentActivity'
import { useImgFx } from '~/composables/useImgFx'
import TakesStrip from '~/components/vue-canvas/TakesStrip.vue'
import LightTableModal from '~/components/vue-canvas/LightTableModal.vue'
import RefNameDialog from '~/components/vue-canvas/RefNameDialog.vue'
import { useNextStepsStrip, type FixChip } from '~/composables/useNextStepsStrip'
import { projectTake, discardOthers, type Take } from '~/composables/useTakes'
import { uploadRefFile } from '~/lib/shotdirector/refUpload'
import { useCharacters } from '~/composables/useCharacters'
import { ACTION_HINTS } from '~/lib/artifact/nextSteps'
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
const maskColor = computed(() => getTypeColor('MASK'))

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

// One-click remove: open the inpaint editor pre-set to click-select, which
// auto-runs a removal as soon as an object is picked.
function openRemoveObject() {
  window.dispatchEvent(new CustomEvent('sailor:openInpaint', { detail: { nodeId: props.id, intent: 'remove' } }))
}

// One-click recolor: open the inpaint editor pre-set to click-select; picking
// an object reveals a swatch strip (brand colors first) that runs the recolor.
function openRecolor() {
  window.dispatchEvent(new CustomEvent('sailor:openInpaint', { detail: { nodeId: props.id, intent: 'recolor' } }))
}

// Knock out the background: splice a local BackgroundRemove node after this image
// (default 'transparent' RGBA output) and re-point whatever the image fed. The
// canvas owns the graph mutation, so we just announce intent.
function removeBackground() {
  window.dispatchEvent(new CustomEvent('sailor:applyEffect', {
    detail: {
      nodeId: props.id,
      nodeType: 'BackgroundRemove',
      output: 'IMAGE',
      widgetOverrides: { output: 'transparent' },
    },
  }))
}

// OUTPUT_NODE nodes get a per-node Run affordance — the existing event the
// canvas listens for. We surface it both as a fallback in the waiting state
// and as a small re-render button in the populated footer.
function runThisNode() {
  if (isMuted.value || isBypassed.value || props.data.running) return
  window.dispatchEvent(
    new CustomEvent('sailor:runFiltered', { detail: { targetIds: [props.id], rerollScope: 'self' } }),
  )
}

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

// Critique: have the agent LOOK at this result and suggest fixes (run→look→fix).
// Surfaced in the Edit menu as "Fix" (label only — the pipeline is unchanged).
function critiqueResult() {
  window.dispatchEvent(new CustomEvent('sailor:critiqueNode', { detail: { nodeId: props.id } }))
}

// Wire an "Edit an image" (Nano Banana) generator downstream of this image, so
// the user can describe an edit in natural language. Same splice path Remove BG
// uses; the model is forced to Nano Banana 2 (EditImageNode's strong editor).
function editWithNanoBanana() {
  window.dispatchEvent(new CustomEvent('sailor:applyEffect', {
    detail: {
      nodeId: props.id,
      nodeType: 'EditImageNode',
      output: 'IMAGE',
      widgetOverrides: { model: 'Nano Banana 2' },
    },
  }))
}

// ── Escalator actions (ARPU levers 2+5) ─────────────────────────────────────
// Enhance/Relight/Lens spawn their generator pre-wired and focused but UN-RUN
// (the user aims first, then pays). Upscale is a true one-tap: spawn + run,
// upstream artifact frozen so only the upscaler bills. All four BRANCH off the
// image (unlike Retouch's true splices): they produce a new deliverable, so
// they must never re-point the existing chain through a paid node.
function spliceEffect(nodeType: string, opts: { run?: boolean; focus?: boolean; branch?: boolean } = {}, widgetOverrides?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent('sailor:applyEffect', {
    detail: { nodeId: props.id, nodeType, output: 'IMAGE', widgetOverrides, ...opts },
  }))
}
function spawnEnhanceDetail() { spliceEffect('EnhanceDetailNode', { focus: true, branch: true }) }
function spawnUpscale() { spliceEffect('UpscaleImageNode', { run: true, branch: true }) }
function spawnRelight() { spliceEffect('RelightNode', { focus: true, branch: true }) }
function spawnLensReframe() { spliceEffect('LensReframe', { focus: true, branch: true }) }

// Restyle in one of the user's OWN trained style LoRAs: branch a
// RestyleWithLoRANode off this image, focused but UN-RUN so the user picks
// their style from the LoRA gallery (the node's lora_picker widget) and pays
// on their own trigger. Captions internally — no prompt widget to fill.
function spawnRestyleWithLoRA() { spliceEffect('RestyleWithLoRANode', { focus: true, branch: true }) }

// Variations ×4: sequential re-runs of the producing generator with fresh
// seeds; results accumulate in the Takes strip. Needs something upstream to
// re-run, hence the hasUpstream gate (mirrored as a disabled menu row).
function runVariations() {
  window.dispatchEvent(new CustomEvent('sailor:runVariations', { detail: { nodeId: props.id, count: 4 } }))
}

// Animate: spawn a Shot Director seeded with this image as reference.
function animateArtifact() {
  window.dispatchEvent(new CustomEvent('sailor:animateArtifact', { detail: { nodeId: props.id } }))
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

// Two hover-revealed side menus: EDIT refines THIS image (retouch / enhance +
// any AI critique fixes), NEXT transforms it into something new (variations,
// reframe, animate). Both panels are TELEPORTED to <body> in screen space —
// inside the node they'd be clipped by the card's overflow and the node bounds
// — and clamped to the viewport with their own scroll, so they stay readable at
// low canvas zoom. Only one is open at a time; clicking outside dismisses it.
const hovered = ref(false)
const editMenuOpen = ref(false)
const editMenuRef = ref<HTMLElement | null>(null)
const editMenuPanelRef = ref<HTMLElement | null>(null)
const editMenuStyle = ref<Record<string, string>>({})
const nextMenuOpen = ref(false)
const nextMenuRef = ref<HTMLElement | null>(null)
const nextMenuPanelRef = ref<HTMLElement | null>(null)
const nextMenuStyle = ref<Record<string, string>>({})
onClickOutside(editMenuRef, () => { editMenuOpen.value = false }, { ignore: [editMenuPanelRef] })
onClickOutside(nextMenuRef, () => { nextMenuOpen.value = false }, { ignore: [nextMenuPanelRef] })

// ── Edit text popover — find/replace fields, spawns a TextEditNode ───────────
const textEditOpen = ref(false)
const textEditPanelRef = ref<HTMLElement | null>(null)
const textEditStyle = ref<Record<string, string>>({})
const textFind = ref('')
const textReplace = ref('')
onClickOutside(textEditPanelRef, () => { textEditOpen.value = false })

function openTextEdit() {
  textEditStyle.value = menuStyleFor(editMenuRef.value)
  textFind.value = ''
  textReplace.value = ''
  textEditOpen.value = true
}

function runTextEdit() {
  if (!textFind.value.trim() || !textReplace.value.trim()) return
  spliceEffect('TextEditNode', { run: true, branch: true }, { find: textFind.value.trim(), replace: textReplace.value.trim() })
  textEditOpen.value = false
}

// Beside the node's right edge, top-aligned with the button; flips to the
// node's left when the viewport runs out. Vertical position clamps so the panel
// always fits, scrolling internally as a last resort on short viewports.
function menuStyleFor(anchor: HTMLElement | null): Record<string, string> {
  const nodeR = (anchor?.closest('.artifact-image') as HTMLElement | null)?.getBoundingClientRect()
  const btnR = anchor?.getBoundingClientRect()
  if (!nodeR || !btnR) return {}
  const MENU_W = 210
  const MENU_H = 380
  const left = nodeR.right + 8 + MENU_W <= window.innerWidth
    ? nodeR.right + 8
    : Math.max(8, nodeR.left - 8 - MENU_W)
  const top = Math.max(8, Math.min(btnR.top, window.innerHeight - MENU_H - 8))
  return { left: `${left}px`, top: `${top}px`, maxHeight: `${window.innerHeight - top - 8}px` }
}
// Pan/zoom would leave the fixed panel floating at a stale spot — close instead.
function closeMenusOnWheel() { editMenuOpen.value = false; nextMenuOpen.value = false }
watch([editMenuOpen, nextMenuOpen], ([edit, next], [prevEdit, prevNext]) => {
  if (edit && !prevEdit) { nextMenuOpen.value = false; editMenuStyle.value = menuStyleFor(editMenuRef.value) }
  if (next && !prevNext) { editMenuOpen.value = false; nextMenuStyle.value = menuStyleFor(nextMenuRef.value) }
  if (edit || next) window.addEventListener('wheel', closeMenusOnWheel, { passive: true })
  else window.removeEventListener('wheel', closeMenusOnWheel)
})
onBeforeUnmount(() => window.removeEventListener('wheel', closeMenusOnWheel))
function runAction(action: () => void) {
  editMenuOpen.value = false
  nextMenuOpen.value = false
  action()
}

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

// --- AI critique fixes (surfaced in the Edit menu) --------------------------
// A paid render triggers a quiet critique pass (gate lives in CanvasPromptBar);
// any fixes it finds land on the `fixes` channel and show at the top of THIS
// artifact's Edit menu. Baseline is taken at mount so restoring a saved canvas
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
const fixChipsForMe = computed(() => nextSteps.fixesFor(props.id))
function applyFix(chip: FixChip) {
  editMenuOpen.value = false
  chip.apply()
  nextSteps.clearFixes(props.id)
}

// Promote button price hint — this node's own price badge (a promote reruns
// the SAME generator at full quality, so its badge is the right estimate).
const hostedPricing = hostedModeEnabled(useRuntimeConfig().public)
const promoteUsdLabel = computed(() => {
  const cost = parseBadgeUsd((props.data as any)?.priceBadge?.expr)
  return cost ? ` ${formatCostBadge(cost.usd, true, hostedPricing)}` : null
})
</script>

<template>
  <div
    class="artifact-image relative w-[240px] select-none"
    :class="{
      'artifact-image--muted': isMuted,
      'artifact-image--bypassed': isBypassed,
      'artifact-image--locked': isLocked,
    }"
    :data-running="data.running || undefined"
    :style="{ '--port-color': imageColor } as any"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <VueCanvasNodeReadyBadge :node-id="id" />
    <!-- Primary IMAGE input — vertically centered on the image frame.
         Conditionally rendered so empty Image nodes don't dangle a port. -->
    <Handle
      v-if="imagesInIdx >= 0"
      :id="`input-${imagesInIdx}`"
      type="target"
      :position="Position.Left"
      class="!w-3 !h-3 !rounded-full !border-2 !bg-[#1a1a1a]"
      :style="{ borderColor: imageColor, top: '50%' }"
    />
    <!-- Primary IMAGE output -->
    <Handle
      v-if="imageOutIdx >= 0"
      :id="`output-${imageOutIdx}`"
      type="source"
      :position="Position.Right"
      class="!w-3 !h-3 !rounded-full !border-2 !bg-[#1a1a1a]"
      :style="{ borderColor: imageColor, top: '50%' }"
    />

    <div
      class="artifact-frame relative rounded-lg overflow-hidden bg-black/40 border border-white/10"
      :class="{ 'ring-2 ring-red-500': data.error }"
    >
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
        <!-- Chrome toolbar, overlaid on the top of the image and revealed
             on hover. Kept off the resting card so the image itself is the
             only thing competing for attention. Lock state is NOT hidden
             here — it changes what Run does, so it also shows as a badge. -->
        <div
          class="nopan nodrag absolute inset-x-0 top-0 z-30 flex items-center gap-1.5 px-2 py-1.5 bg-gradient-to-b from-black/70 to-transparent transition-opacity duration-150"
          :class="hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'"
        >
          <span class="truncate flex-1 text-[10px] tabular-nums text-white/80 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
            {{ dims || (hasUpstream ? 'Preview' : 'Image') }}
          </span>
          <button
            v-if="canReplace"
            class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center text-white/45 hover:text-white/85 hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-50"
            :disabled="uploading"
            title="Replace image"
            @click.stop="triggerUpload"
          >
            <Loader2 v-if="uploading" class="size-3 animate-spin" />
            <Upload v-else class="size-2.5" />
          </button>
          <button
            class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center text-white/45 hover:text-white/85 hover:bg-white/[0.08] transition-colors cursor-pointer"
            title="Download"
            @click.stop="downloadImage"
          >
            <Download class="size-2.5" />
          </button>
          <button
            class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center transition-colors cursor-pointer disabled:opacity-50"
            :class="isLocked
              ? 'text-amber-300 bg-amber-500/15 hover:bg-amber-500/25'
              : 'text-white/45 hover:text-white/85 hover:bg-white/[0.08]'"
            :disabled="locking"
            :title="isLocked ? 'Locked — pinned, upstream will be skipped on next Run. Click to unlock.' : 'Lock — pin this image so upstream generators don\'t re-run.'"
            @click.stop="isLocked ? unlockArtifact() : lockArtifact()"
          >
            <Loader2 v-if="locking" class="size-3 animate-spin" />
            <Lock v-else-if="isLocked" class="size-2.5" />
            <LockOpen v-else class="size-2.5" />
          </button>
          <button
            class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center text-white/45 hover:text-white/85 hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-50"
            :disabled="data.running || isMuted || isBypassed"
            :title="data.running ? 'Running…' : 'Re-render'"
            @click.stop="runThisNode"
          >
            <Loader2 v-if="data.running" class="size-3 animate-spin" />
            <RefreshCw v-else class="size-3" />
          </button>
          <button
            class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center text-white/45 hover:text-white/85 hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-50"
            :disabled="savingAsCharacter"
            title="Save as character"
            @click.stop="saveAsCharacter"
          >
            <Loader2 v-if="savingAsCharacter" class="size-3 animate-spin" />
            <Drama v-else class="size-3" />
          </button>
          <button
            v-if="displayedUrl"
            class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center text-white/45 hover:text-white/85 hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-50"
            :disabled="creatingRef"
            title="Name as reusable reference (@)"
            @click.stop="openRefDialog"
          >
            <Loader2 v-if="creatingRef" class="size-3 animate-spin" />
            <span v-else class="text-xs font-bold leading-none" style="color: var(--var-accent-text)">@</span>
          </button>
        </div>
        <!-- Persistent lock badge: the toggle lives in the hover toolbar,
             but a pinned card must read as pinned without hovering it. -->
        <div
          v-if="isLocked"
          class="pointer-events-none absolute top-1.5 left-1.5 z-20 flex items-center gap-1 rounded bg-amber-500/20 border border-amber-400/30 px-1.5 py-0.5 text-[9px] font-medium text-amber-200 backdrop-blur-sm"
        >
          <Lock class="size-2.5" /> Locked
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

      <!-- Footer toolbar — OUTSIDE the media stage, so the churn/reveal effect
           covers only the image and never these controls. -->
      <template v-if="displayedUrl">
        <!-- Primary actions, below the image. EDIT refines this image;
             NEXT turns it into something new. Always visible and styled
             like the Edit/Render footer on studio nodes — these are the
             card's main affordances, not chrome to hide behind a hover. -->
        <div class="nopan nodrag flex items-center gap-1.5 px-2 py-2 border-t border-white/5">
          <!-- EDIT — fix / refine the current iteration -->
          <div ref="editMenuRef" class="relative flex-1">
            <button
              class="w-full flex items-center justify-center gap-1.5 rounded bg-white/10 hover:bg-white/20 px-2.5 py-1.5 text-[11px] font-medium text-white/80 hover:text-white transition-colors cursor-pointer"
              title="Edit — refine this image"
              @click.stop="editMenuOpen = !editMenuOpen"
            >
              <Pencil class="size-3" /> Edit…
              <Sparkles v-if="fixChipsForMe.length" class="size-2.5 -mr-0.5" />
            </button>
            <Teleport to="body">
            <div
              v-if="editMenuOpen"
              ref="editMenuPanelRef"
              class="nopan nodrag fixed z-[9999] min-w-[190px] overflow-y-auto rounded-md border border-white/10 bg-[#1a1a1a] shadow-lg py-1"
              :style="editMenuStyle"
            >
              <!-- AI critique fixes lead the menu when the reviewer found any. -->
              <template v-if="fixChipsForMe.length">
                <div class="px-2.5 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-white/30 select-none">Suggested fixes</div>
                <button
                  v-for="chip in fixChipsForMe"
                  :key="chip.id"
                  class="edit-menu-item"
                  :title="chip.hint ? `${chip.label} (${chip.hint})` : chip.label"
                  @click.stop="applyFix(chip)"
                >
                  <Sparkles class="size-3 shrink-0" /> {{ chip.label }}
                  <span v-if="chip.hint" class="edit-menu-hint">{{ chip.hint }}</span>
                </button>
                <div class="mt-1 border-t border-white/[0.06]" />
              </template>
              <div class="px-2.5 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-white/30 select-none">Retouch</div>
              <button class="edit-menu-item" @click.stop="runAction(removeBackground)">
                <Eraser class="size-3 shrink-0" /> Remove BG
              </button>
              <button class="edit-menu-item" @click.stop="runAction(openInpaint)">
                <Brush class="size-3 shrink-0" /> Inpaint
              </button>
              <button class="edit-menu-item" @click.stop="runAction(openRemoveObject)">
                <Scissors class="size-3 shrink-0" /> Remove object
                <span class="edit-menu-hint">click it</span>
              </button>
              <button class="edit-menu-item" @click.stop="runAction(openRecolor)">
                <Palette class="size-3 shrink-0" /> Recolor…
                <span class="edit-menu-hint">click + pick</span>
              </button>
              <button class="edit-menu-item" @click.stop="runAction(openTextEdit)">
                <Type class="size-3 shrink-0" /> Edit text…
                <span class="edit-menu-hint">find / replace</span>
              </button>
              <button class="edit-menu-item" @click.stop="runAction(editWithNanoBanana)">
                <Wand2 class="size-3 shrink-0" /> Edit (Nano Banana)
                <span class="edit-menu-hint">{{ ACTION_HINTS['nano-banana'] }}</span>
              </button>
              <button class="edit-menu-item" @click.stop="runAction(spawnRestyleWithLoRA)">
                <Paintbrush class="size-3 shrink-0" /> Restyle…
                <span class="edit-menu-hint">your style LoRA</span>
              </button>
              <button v-if="data.images?.length" class="edit-menu-item" @click.stop="runAction(critiqueResult)">
                <Sparkles class="size-3 shrink-0" /> Fix
              </button>

              <div class="mt-1 border-t border-white/[0.06] px-2.5 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider text-white/30 select-none">Enhance</div>
              <button class="edit-menu-item" @click.stop="runAction(spawnEnhanceDetail)">
                <Gem class="size-3 shrink-0" /> Enhance Detail
                <span class="edit-menu-hint">{{ ACTION_HINTS.enhance }}</span>
              </button>
              <button class="edit-menu-item" @click.stop="runAction(spawnUpscale)">
                <ZoomIn class="size-3 shrink-0" /> Upscale
                <span class="edit-menu-hint">{{ ACTION_HINTS.upscale }}</span>
              </button>
              <button class="edit-menu-item" @click.stop="runAction(spawnRelight)">
                <Lamp class="size-3 shrink-0" /> Relight
                <span class="edit-menu-hint">{{ ACTION_HINTS.relight }}</span>
              </button>
            </div>
            </Teleport>
          </div>

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

          <!-- NEXT — transform into something new -->
          <div ref="nextMenuRef" class="relative flex-1">
            <button
              class="w-full flex items-center justify-center gap-1.5 rounded bg-white/10 hover:bg-white/20 px-2.5 py-1.5 text-[11px] font-medium text-white/80 hover:text-white transition-colors cursor-pointer"
              title="Develop — turn this into something new"
              @click.stop="nextMenuOpen = !nextMenuOpen"
            >
              <ArrowRight class="size-3" /> Develop…
            </button>
            <Teleport to="body">
            <div
              v-if="nextMenuOpen"
              ref="nextMenuPanelRef"
              class="nopan nodrag fixed z-[9999] min-w-[190px] overflow-y-auto rounded-md border border-white/10 bg-[#1a1a1a] shadow-lg py-1"
              :style="nextMenuStyle"
            >
              <div class="px-2.5 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-white/30 select-none">Create</div>
              <button
                class="edit-menu-item disabled:opacity-35 disabled:cursor-default"
                :disabled="!hasUpstream"
                :title="hasUpstream ? 'Re-run the generator 4× with fresh seeds' : 'Nothing upstream to re-run — this image was uploaded'"
                @click.stop="runAction(runVariations)"
              >
                <Shuffle class="size-3 shrink-0" /> Variations ×4
                <span class="edit-menu-hint">{{ ACTION_HINTS.variations }}</span>
              </button>
              <button class="edit-menu-item" @click.stop="runAction(spawnLensReframe)">
                <Aperture class="size-3 shrink-0" /> Reframe · Format
                <span class="edit-menu-hint">{{ ACTION_HINTS.lens }}</span>
              </button>
              <button class="edit-menu-item" @click.stop="runAction(animateArtifact)">
                <Clapperboard class="size-3 shrink-0" /> Animate
                <span class="edit-menu-hint">{{ ACTION_HINTS.animate }}</span>
              </button>
            </div>
            </Teleport>
          </div>
        </div>
      </template>
    </div>

    <!-- Name-as-reference dialog (self-teleports to <body>). -->
    <RefNameDialog :open="refDialogOpen" @confirm="onRefConfirm" @cancel="refDialogOpen = false" />

    <!-- Takes strip (flag-gated): switch / pin / discard this node's results -->
    <TakesStrip
      v-if="(data.takes?.length ?? 0) >= 1"
      :takes="data.takes!"
      :active-take-id="data.activeTakeId"
      class="mt-1 rounded-lg bg-black/40 border border-white/10"
      @select="selectTake"
      @pin="pinTake"
      @discard="discardTake"
      @expand="lightTableOpen = true"
      @promote="promoteTake"
    />

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

    <!-- Secondary MASK output — small port + label below the frame so the
         image stays the dominant visual but downstream MASK consumers stay
         wireable. -->
    <div
      v-if="maskOutIdx >= 0"
      class="mt-1 flex items-center gap-1 justify-end pr-1"
    >
      <span class="text-[9px] uppercase tracking-[0.04em] text-white/35">mask</span>
      <Handle
        :id="`output-${maskOutIdx}`"
        type="source"
        :position="Position.Right"
        class="!w-2 !h-2 !rounded-full !border !bg-[#1a1a1a] !relative !top-auto !right-auto !transform-none"
        :style="{ borderColor: maskColor }"
      />
    </div>
  </div>
</template>

<style scoped>
.artifact-image[data-running] .artifact-frame {
  box-shadow:
    0 0 0 2px var(--port-color, #fff),
    0 4px 16px rgba(0, 0, 0, 0.4);
}
.artifact-frame {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 1px 4px rgba(0, 0, 0, 0.2);
}
.artifact-image--muted { opacity: 0.45; filter: grayscale(0.8); }
.artifact-image--bypassed { opacity: 0.85; }
.artifact-image--bypassed .artifact-frame {
  border-style: dashed;
  border-color: rgba(251, 191, 36, 0.35);
}
.artifact-image--locked .artifact-frame {
  /* Amber tint to match the seed-lock toggle's visual language — same
     "frozen / pinned" signal across the canvas. */
  box-shadow:
    0 0 0 1px rgba(251, 191, 36, 0.4),
    0 4px 16px rgba(0, 0, 0, 0.4);
  border-color: rgba(251, 191, 36, 0.25);
}

/* Edit… dropdown rows — shared by all three sections. */
.edit-menu-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.625rem;
  font-size: 11px;
  color: rgb(255 255 255 / 0.75);
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s;
}
.edit-menu-item:hover:not(:disabled) {
  color: #fff;
  background-color: rgb(255 255 255 / 0.08);
}
.edit-menu-hint {
  margin-left: auto;
  padding-left: 0.75rem;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  color: rgb(255 255 255 / 0.35);
}
</style>
