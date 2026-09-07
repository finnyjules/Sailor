<script setup lang="ts">
/**
 * Train LoRA — top-level surface for training SDXL/SD1.5/Flux LoRAs.
 *
 * The trainer engine is the existing TrainLoraNode in comfy_extras/nodes_train.py.
 * This page builds the workflow graph in code and submits it to /prompt, the
 * same pattern the Apps use.
 *
 * Flow:
 *   1. Upload images to input/<sessionFolder>/  via /upload/image
 *   2. Post captions to /sailor/lora/save_captions  → writes .txt sidecars
 *   3. Build graph: CheckpointLoaderSimple → LoadImageTextDataSetFromFolder
 *      → MakeTrainingDataset → TrainLoraNode → SaveLoRA
 *   4. POST /prompt, poll /history/<id>
 */
import { ArrowRight, Check, ChevronDown, ChevronRight, Cloud, Cpu, Download, Drama, Loader2, Plus, RefreshCcw, Sparkles, Upload, Wand, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { assembleAesthetic } from '~/lib/lora/aesthetic'
import { DEFAULT_LORA_RANK } from '~~/shared/lora-defaults'
import JSZip from 'jszip'
import {
  CHARACTER_SHOT_SCENES,
  pickScenes,
  aspectForFraming,
  syntheticCount,
  type CharacterShotScene,
} from '~/data/character-shot-scenes'

// ----- Compute mode (Local vs Cloud) ------------------------------------

type ComputeMode = 'local' | 'cloud'
const computeMode = ref<ComputeMode>('local')

// Cloud family — what Replicate trainer to use. Independent of the local
// checkpoint picker (which is moot in cloud mode).
type CloudFamily = 'flux' | 'sdxl_sd15'
const cloudFamily = ref<CloudFamily>('flux')

// Cloud training state — populated when a prediction is in flight.
interface CloudJob {
  predictionId: string
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled'
  logs?: string
  error?: string | null
  localFilename?: string | null
  replicateUrl?: string | null
  replicateModel?: string | null
}
const cloudJob = ref<CloudJob | null>(null)

// ----- Downloadable base checkpoints -------------------------------------

interface DownloadableCheckpoint {
  key: string         // matches the server-side bundle key
  label: string
  family: 'SDXL' | 'SD1.5' | 'Flux'
  sizeBytes: number
  blurb: string
}

const DOWNLOADABLE_CHECKPOINTS: DownloadableCheckpoint[] = [
  {
    key: 'lora-base-sdxl',
    label: 'SDXL Base 1.0',
    family: 'SDXL',
    sizeBytes: 6_938_078_334,
    blurb: 'Best default for characters and styles. 1024×1024 native.',
  },
  {
    key: 'lora-base-sd15',
    label: 'Stable Diffusion 1.5',
    family: 'SD1.5',
    sizeBytes: 4_265_146_304,
    blurb: 'Faster to train, smaller VRAM footprint. 512×512 native.',
  },
  {
    key: 'lora-base-flux-schnell',
    label: 'Flux.1 Schnell',
    family: 'Flux',
    sizeBytes: 23_782_506_688 + 335_304_388 + 246_144_152 + 4_893_934_904,
    blurb: 'Open-license Flux. Heavy download (~29 GB across 4 files), high VRAM. Enable CPU offload in Advanced.',
  },
]

// Synthetic option value the picker uses to represent the Flux multi-file
// setup. Detected by buildTrainingPrompt to switch workflow shape.
const FLUX_OPTION_VALUE = '__flux_schnell__'
const FLUX_FILES = {
  unet: 'flux1-schnell.safetensors',
  vae: 'ae.safetensors',
  clipL: 'clip_l.safetensors',
  t5: 't5xxl_fp8_e4m3fn.safetensors',
}
const fluxReady = ref(false)

async function probeFluxReady() {
  try {
    const r = await fetch('/sailor/models/status?key=lora-base-flux-schnell')
    if (r.ok) {
      const status = await r.json()
      fluxReady.value = !!status.ready
    }
  } catch { /* silent — surface will just hide the option */ }
}

interface CheckpointDownloadState {
  phase: 'idle' | 'checking' | 'downloading' | 'preparing' | 'done' | 'error'
  downloaded: number
  total: number
  message?: string
}
const downloadStates = reactive<Record<string, CheckpointDownloadState>>({})
for (const c of DOWNLOADABLE_CHECKPOINTS) {
  downloadStates[c.key] = { phase: 'idle', downloaded: 0, total: c.sizeBytes }
}

function fmtGB(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1)
}
function downloadPct(key: string): number {
  const s = downloadStates[key]
  if (!s?.total) return 0
  return Math.round((s.downloaded / s.total) * 100)
}

async function downloadCheckpoint(key: string) {
  const state = downloadStates[key]
  if (!state || state.phase === 'downloading' || state.phase === 'preparing') return
  state.phase = 'checking'
  state.message = undefined
  state.downloaded = 0

  try {
    // Quick status probe first — if already on disk we can skip the stream.
    const probe = await fetch(`/sailor/models/status?key=${key}`)
    if (probe.ok) {
      const status = await probe.json()
      if (status.ready) {
        state.phase = 'done'
        state.downloaded = state.total
        await loadCheckpoints()
        return
      }
    }
  } catch {
    state.phase = 'error'
    state.message = 'Could not reach the model server. Is ComfyUI running?'
    return
  }

  await new Promise<void>((resolve) => {
    const es = new EventSource(`/sailor/models/download?key=${key}`)
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.phase === 'downloading') {
          state.phase = 'downloading'
          state.downloaded = msg.downloaded ?? 0
          state.total = msg.total ?? state.total
        } else if (msg.phase === 'preparing') {
          state.phase = 'preparing'
        } else if (msg.phase === 'done') {
          state.phase = 'done'
          state.downloaded = state.total
          es.close()
          loadCheckpoints().finally(() => resolve())
        } else if (msg.phase === 'error') {
          state.phase = 'error'
          state.message = msg.message || 'Download failed.'
          es.close()
          resolve()
        }
      } catch {}
    }
    es.onerror = () => {
      if (state.phase !== 'done' && state.phase !== 'error') {
        state.phase = 'error'
        state.message = 'Lost connection to the model server.'
      }
      es.close()
      resolve()
    }
  })
}

// ----- Dataset state -----------------------------------------------------

interface DatasetImage {
  file: File
  filename: string       // server-side filename after /upload/image
  previewUrl: string     // local blob: URL for preview
  caption: string
  captionState: 'idle' | 'captioning' | 'done' | 'error'
  generated?: boolean    // came from "Build character dataset" (re-rollable)
  isReference?: boolean  // came from a real reference photo (not generated)
  scene?: string         // the scene prompt used, so regenerate re-rolls the same shot type
}

const sessionFolder = `lora_dataset_${Date.now()}`
const images = ref<DatasetImage[]>([])
const status = ref<'idle' | 'uploading' | 'captioning' | 'submitting' | 'training' | 'done' | 'queued' | 'error'>('idle')
// Name of the last style added to the cloud queue, shown in the confirmation.
const queuedName = ref<string | null>(null)
const errorMessage = ref<string | null>(null)
const progressLabel = ref('')
const progressPct = ref(0)
// Aesthetic auto-generated from the dataset at train time, then
// threaded into /status → sidecar → prepended to prompts when the LoRA is used.
const cloudAesthetic = ref<string | null>(null)
const outputFilename = ref<string | null>(null)
const lossGraphUrl = ref<string | null>(null)

// What you're training. Drives the caption strategy: a character's captions
// must NOT describe the identity (it has to live in the trigger word), whereas
// a style's captions describe the content normally. Also tags the LoRA's
// `kind` on success so a character lands in the Characters panel.
const trainingKind = ref<'style' | 'character' | 'voice'>('style')
// Kind-aware labels so the page reads correctly across styles, characters, voices.
const kindLabel = computed(() => (
  trainingKind.value === 'character' ? 'Character'
  : trainingKind.value === 'voice' ? 'Voice'
  : 'Style'))
const kindNoun = computed(() => (
  trainingKind.value === 'character' ? 'character'
  : trainingKind.value === 'voice' ? 'voice'
  : 'style'))
// Training knobs (steps/LR/rank) collapse under an Advanced disclosure.
const advancedSettingsOpen = ref(false)

// "Build character dataset" — bootstrap a varied, consistent training set from
// a small set of reference photos via ideogram-character (see buildCharacterDataset).
const refInputRef = ref<HTMLInputElement | null>(null)

// A small set of reference photos. Real ones flagged `includeInTraining` are
// added to the dataset directly (this is what captures true body type);
// Ideogram seeds synthetic variety from them, round-robin (one ref per call).
interface ReferenceItem { file: File; previewUrl: string; includeInTraining: boolean; addedToDataset?: boolean }
const referenceFiles = ref<ReferenceItem[]>([])
const MAX_REFERENCES = 5

const subjectHint = ref('')
const datasetCount = ref(16)
const buildingDataset = ref(false)
const buildProgress = reactive({ done: 0, total: 0 })
const buildError = ref<string | null>(null)

const realIncludedCount = computed(
  () => referenceFiles.value.filter((r) => r.includeInTraining).length,
)

// Nudge: with no real photo flagged for training, body type can only come from
// Ideogram's invention. Non-blocking.
const showBodyHint = computed(
  () => trainingKind.value === 'character'
    && referenceFiles.value.length > 0
    && realIncludedCount.value === 0,
)

// ----- Hyperparameters ---------------------------------------------------

const checkpoints = ref<string[]>([])
const checkpointsLoading = ref(false)
const checkpointsError = ref<string | null>(null)

const form = reactive({
  checkpoint: '',
  outputName: 'my_style',
  triggerWord: '',
  steps: 1000,
  learningRate: 0.0004,
  rank: DEFAULT_LORA_RANK,
  // Advanced
  batchSize: 1,
  gradAccumulationSteps: 1,
  optimizer: 'AdamW',
  lossFunction: 'MSE',
  trainingDtype: 'bf16',
  loraDtype: 'bf16',
  algorithm: 'lora',
  gradientCheckpointing: true,
  checkpointDepth: 1,
  offloading: false,
  seed: 0,
  bucketMode: false,
  bypassMode: false,
})

const advancedOpen = ref(false)

// Open a fresh workflow with a Flux generator preloaded to use the trained LoRA.
// FluxLoRARemoteNode resolves the local filename to its CDN url via the sidecar
// JSON our cloud-train route wrote, so the LoRA "just works" in the new graph.
const { openTab, activeTabId } = useTabs()
const { seedVersion } = usePendingTrainerSeed()
function useTrainedLoraInWorkflow() {
  const fname = cloudJob.value?.localFilename
  if (!fname) return
  const trigger = (form.triggerWord || '').trim()
  // Style block (aesthetic + trigger) → the node's "Style" property (folded
  // into the prompt at run time). Schema-stable; prompt left clean for the scene.
  const profile = (cloudAesthetic.value || importedAesthetic.value || '').trim()
  const style = [profile, trigger ? `${trigger},` : ''].filter(Boolean).join(' ')
  const promptText = ''
  // Drive the LoRA via `lora_url` set to the trained Replicate MODEL REF
  // (<owner>/<model>) — the node runs that model directly. We can't use the
  // `lora_name` combo (its options come from the canvas's cached object_info,
  // which predates this fresh training, so the new file resets to empty), and we
  // must NOT use the `.tar` CDN url (flux-dev-lora can't parse it). We still set
  // lora_name too, so the dropdown shows it once object_info reloads.
  const loraRef = cloudJob.value?.replicateModel || ''
  const workflow = {
    last_node_id: 1,
    last_link_id: 0,
    nodes: [{
      id: 1,
      type: 'FluxLoRARemoteNode',
      pos: [360, 220],
      size: [360, 460],
      flags: {},
      order: 0,
      mode: 0,
      inputs: [],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', links: null, slot_index: 0 }],
      // aesthetic is a node property (folded into the prompt at run time).
      properties: { 'Node name for S&R': 'FluxLoRARemoteNode', aesthetic: style },
      // widget order (schema, 10 widgets): prompt, lora_name, lora_url,
      // lora_scale, aspect_ratio, megapixels, num_inference_steps, guidance,
      // seed, prompt_strength. seed has no control_after_generate, so no
      // trailing control value.
      widgets_values: [promptText, fname, loraRef, 1.0, '1:1', '1', 28, 3.5, 0, 0.8],
    }],
    links: [],
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  }
  const tab = openTab({ type: 'project', label: `Style: ${(form.outputName || 'style').trim()}` })
  window.dispatchEvent(new CustomEvent('sailor:loadTabWorkflow', {
    detail: { tabId: tab.id, workflow },
  }))
}

// Load checkpoint list from /object_info
async function loadCheckpoints() {
  checkpointsLoading.value = true
  checkpointsError.value = null
  try {
    const res = await fetch('/object_info/CheckpointLoaderSimple')
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    const data = await res.json()
    const ckptList = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? []
    checkpoints.value = Array.isArray(ckptList) ? ckptList : []
  } catch (e: any) {
    checkpointsError.value = e?.message ?? 'Failed to load checkpoints. Is ComfyUI running?'
  } finally {
    checkpointsLoading.value = false
  }
}

// Combined picker options: real SDXL/SD1.5 checkpoints + synthetic Flux entry.
interface CheckpointOption { value: string; label: string; family: 'sdxl_sd15' | 'flux' }
const checkpointOptions = computed<CheckpointOption[]>(() => {
  const opts: CheckpointOption[] = checkpoints.value.map(c => ({ value: c, label: c, family: 'sdxl_sd15' as const }))
  if (fluxReady.value) opts.push({ value: FLUX_OPTION_VALUE, label: 'Flux.1 Schnell (multi-file)', family: 'flux' as const })
  return opts
})

const selectedFamily = computed<'sdxl_sd15' | 'flux'>(() => {
  const opt = checkpointOptions.value.find(o => o.value === form.checkpoint)
  return opt?.family ?? 'sdxl_sd15'
})

// Cloud cost + time estimate. Numbers based on Replicate's ostris trainers
// running on H100 80GB ($0.001525/sec = $5.49/hr). Step times are observed
// averages — rough but in the right ballpark.
const REPLICATE_H100_PER_SEC = 0.001525

const IDEOGRAM_PER_IMAGE = 0.08 // ideogram-character, per generated shot

const costEstimate = computed(() => {
  const steps = Math.max(1, form.steps || 1000)
  const flux = cloudFamily.value === 'flux'
  // ostris flux trainer: ~60s setup + 1.5–2.5s/step; sdxl: ~30s + 0.5–0.9s/step.
  const lowSec = flux ? 60 + steps * 1.5 : 30 + steps * 0.5
  const highSec = flux ? 90 + steps * 2.5 : 45 + steps * 0.9
  const lowUsd = lowSec * REPLICATE_H100_PER_SEC
  const highUsd = highSec * REPLICATE_H100_PER_SEC
  return {
    lowUsd,
    highUsd,
    cost: `~$${lowUsd.toFixed(2)}–${highUsd.toFixed(2)}`,
    time: `~${Math.max(1, Math.round(lowSec / 60))}–${Math.round(highSec / 60)} min`,
    note: flux
      ? 'Cold starts add a minute or two. Long jobs can hit the upper bound.'
      : 'SDXL is the cheaper, faster choice when you don\'t need Flux quality.',
  }
})

// How many synthetic shots will be generated to top up the dataset.
const expectedShots = computed(() => {
  if (trainingKind.value !== 'character' || referenceFiles.value.length === 0) return 0
  const pending = referenceFiles.value.filter((r) => r.includeInTraining && !r.addedToDataset).length
  const target = Math.max(4, Math.min(CHARACTER_SHOT_SCENES.length + pending, datasetCount.value || 16))
  return syntheticCount(target, pending)
})

// Cost of the images you still plan to GENERATE (the ones already on disk are
// sunk). In character mode with a reference set but no shots yet, that's the
// planned dataset; otherwise nothing left to generate.
const plannedDatasetCount = computed(() => {
  if (trainingKind.value !== 'character' || referenceFiles.value.length === 0) return 0
  const generated = images.value.filter(i => i.generated).length
  if (generated > 0) return 0 // already built — cost is sunk
  return expectedShots.value
})

const datasetCostUsd = computed(() => plannedDatasetCount.value * IDEOGRAM_PER_IMAGE)

// Combined "what this character costs from here" — dataset shots still to make
// + the training run. Shown so you can see the whole bill before committing.
const totalEstimate = computed(() => {
  const ds = datasetCostUsd.value
  const low = ds + costEstimate.value.lowUsd
  const high = ds + costEstimate.value.highUsd
  return {
    hasDataset: ds > 0,
    datasetCost: `~$${ds.toFixed(2)}`,
    total: `~$${low.toFixed(2)}–${high.toFixed(2)}`,
  }
})

// Auto-select the first option (SDXL/SD1.5 checkpoint first; Flux if it's the
// only choice). Runs whenever the option list changes.
watch(checkpointOptions, (opts) => {
  if (!form.checkpoint && opts.length > 0) {
    form.checkpoint = opts[0]!.value
  }
}, { immediate: true })

// After a Flux download finishes, mark Flux as ready and refresh the picker.
watch(downloadStates, () => {
  const flux = downloadStates['lora-base-flux-schnell']
  if (flux?.phase === 'done') fluxReady.value = true
}, { deep: true })

// Set when the trainer opens pre-seeded from a draft character with fewer
// than 3 reference photos (via "Train identity" in the Characters panel) —
// shown inline near the dataset so the user knows why it's thin.
const seedLowPhotoWarning = ref(false)

/** Consume a pending trainer seed (see usePendingTrainerSeed) and prefill the form + dataset. */
async function consumePendingSeed() {
  const seed = usePendingTrainerSeed().consume()
  if (!seed) return
  trainingKind.value = seed.kind
  if (seed.name) form.outputName = seed.name
  if (seed.trigger) form.triggerWord = seed.trigger
  const files: File[] = []
  for (const url of seed.refViewUrls) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const blob = await res.blob()
      const filename = new URLSearchParams(url.split('?')[1]).get('filename') || `ref_${files.length}.png`
      files.push(new File([blob], filename, { type: blob.type || 'image/png' }))
    } catch { /* skip a failed fetch */ }
  }
  if (files.length) await addFiles(files)
  if (seed.refViewUrls.length < 3) seedLowPhotoWarning.value = true
}

onMounted(() => {
  loadCheckpoints()
  probeFluxReady()
  consumePendingSeed()
})

// The trainer surface is kept mounted (v-show) once the singleton 'train' tab
// is first opened, so a later "Train identity" click won't remount it and
// onMounted above won't fire again — catch that case by watching seedVersion,
// which increments on each set() call, ensuring we detect new seeds even when
// the tab is already active (avoiding the same-value-assignment dead zone).
watch(seedVersion, () => consumePendingSeed())

// ----- Upload helpers ----------------------------------------------------

async function uploadImage(file: File): Promise<string> {
  const fd = new FormData()
  fd.append('image', file)
  fd.append('subfolder', sessionFolder)
  fd.append('overwrite', 'true')
  const res = await fetch('/upload/image', { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`Upload failed (${res.status})`)
  const data = await res.json()
  return data?.name ?? file.name
}

async function addFiles(fileList: FileList | File[] | null | undefined) {
  if (!fileList) return
  const arr = Array.from(fileList).filter((f) => f.type.startsWith('image/'))
  if (arr.length === 0) return
  errorMessage.value = null
  status.value = 'uploading'
  try {
    for (const file of arr) {
      const filename = await uploadImage(file)
      images.value.push({
        file,
        filename,
        previewUrl: URL.createObjectURL(file),
        caption: '',
        captionState: 'idle',
      })
    }
    // First own upload with no aesthetic yet → reveal the field blank+editable.
    // Krea import sets importedAesthetic to a non-empty string, so this guard
    // (=== null) leaves Krea imports untouched, and won't re-blank on re-uploads.
    if (importedAesthetic.value === null) {
      importedAesthetic.value = ''
      aestheticSource.value = 'images'
    }
    status.value = 'idle'
  } catch (e: any) {
    errorMessage.value = e?.message ?? 'Upload failed.'
    status.value = 'error'
  }
}

function removeImage(idx: number) {
  const img = images.value[idx]
  if (img) URL.revokeObjectURL(img.previewUrl)
  images.value.splice(idx, 1)
}

function clearDataset() {
  for (const img of images.value) URL.revokeObjectURL(img.previewUrl)
  images.value = []
  outputFilename.value = null
  lossGraphUrl.value = null
  errorMessage.value = null
  importedAesthetic.value = null
  aestheticSource.value = null
  status.value = 'idle'
}

// ----- Krea moodboard import ---------------------------------------------

interface KreaBoardMeta {
  id: string | null
  name: string
  imageCount: number
  loadedImages?: number
  aesthetic: string | null
  positiveKeywords: string[]
  previewImages: string[]
  images: { url: string, width: number | null, height: number | null }[]
}

const kreaOpen = ref(false)
const kreaBoardUrl = ref('')      // public board URL (browse/community) — fetched server-side
const kreaFetching = ref(false)
const kreaShowJson = ref(false)   // reveal the paste-JSON fallback (private/owned boards)
const kreaJson = ref('')          // pasted moodboard JSON (DevTools → Copy Response)
const kreaRework = ref(true)      // AI rename + reword on import (original derivative)
const kreaImporting = ref(false)
const kreaReworking = ref(false)
const kreaError = ref<string | null>(null)
const kreaBoards = ref<KreaBoardMeta[]>([])
// When set (from a Krea import), used as the LoRA's aesthetic instead of
// generating one with Qwen — Krea's is higher quality and free.
const importedAesthetic = ref<string | null>(null)
// Where the current aesthetic came from — drives the auto-fill button (images
// only) and the helper copy under the field. null when there's no dataset.
const aestheticSource = ref<'krea' | 'images' | null>(null)

// Turn a board title into a trigger token, e.g. "Echo Flux Vortex" → "echo_flux_vortex".
function slugifyTrigger(title: string): string {
  return (title || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'style'
}

// Public (browse/community) boards: fetch + scrape server-side from the URL.
async function fetchKreaBoard() {
  kreaError.value = null
  kreaBoards.value = []
  const u = kreaBoardUrl.value.trim()
  if (!u) { kreaError.value = 'Paste a Krea moodboard URL.'; return }
  kreaFetching.value = true
  try {
    const res = await fetch(`/api/krea/board?url=${encodeURIComponent(u)}`)
    const data = await res.json() as { moodboards?: KreaBoardMeta[], message?: string }
    if (!res.ok) throw new Error(data?.message || `Failed (${res.status})`)
    kreaBoards.value = (data.moodboards || []).filter((b) => b.images.length > 0)
    if (!kreaBoards.value.length) kreaError.value = 'No images found on that board.'
  } catch (e: any) {
    kreaError.value = e?.message || String(e)
  } finally {
    kreaFetching.value = false
  }
}

// Parse the moodboard JSON the user's authenticated browser produced (Krea's
// API auth is cookie-based, so we can't fetch it server-side — but the response
// the browser already received carries everything we need). Accepts the array
// the gallery endpoint returns, or a single board object.
function parseKreaJson() {
  kreaError.value = null
  kreaBoards.value = []
  const raw = kreaJson.value.trim()
  if (!raw) { kreaError.value = 'Paste the moodboard JSON first.'; return }
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    kreaError.value = "That isn't valid JSON. In DevTools → Network, click the 'moodboards' request → right-click → Copy → Copy Response, then paste here."
    return
  }
  const boards: any[] = Array.isArray(data) ? data : (Array.isArray(data?.moodboards) ? data.moodboards : [data])
  kreaBoards.value = boards
    .map((b: any): KreaBoardMeta => ({
      id: b?.id ?? null,
      name: b?.name || 'Untitled board',
      imageCount: b?.imageCount ?? b?.totalImages ?? (b?.images?.length ?? 0),
      aesthetic: b?.aesthetic ?? null,
      positiveKeywords: Array.isArray(b?.positiveKeywords) ? b.positiveKeywords : [],
      previewImages: Array.isArray(b?.previewImages) ? b.previewImages.slice(0, 4) : [],
      images: (b?.images ?? [])
        .map((im: any) => ({ url: im?.url, width: im?.width ?? null, height: im?.height ?? null }))
        .filter((im: any) => typeof im.url === 'string' && im.url.length > 0),
    }))
    .filter((b) => b.images.length > 0)
  if (!kreaBoards.value.length) {
    kreaError.value = 'No boards with images found in that JSON. Make sure you copied the full response.'
  }
}

// Fisher–Yates shuffle — returns a new array, leaves the original untouched.
function shuffleArray<T>(arr: T[]): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

async function importKreaBoard(board: KreaBoardMeta) {
  kreaError.value = null
  kreaImporting.value = true
  try {
    const files: File[] = []
    for (let i = 0; i < board.images.length; i++) {
      const im = board.images[i]!
      try {
        const res = await fetch(`/api/krea/image?url=${encodeURIComponent(im.url)}`)
        if (!res.ok) continue
        const blob = await res.blob()
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
        files.push(new File([blob], `krea_${String(i + 1).padStart(4, '0')}.${ext}`, { type: blob.type || 'image/png' }))
      } catch { /* skip this image */ }
    }
    if (!files.length) { kreaError.value = 'Could not download any images from that board.'; return }
    await addFiles(files) // reuse: uploads to ComfyUI + builds previews/state

    // Make it an ORIGINAL derivative: AI renames the board + rewords the
    // aesthetic (similar direction, not a copy). Non-fatal — keeps originals on error.
    let finalName = board.name
    let finalProfile = board.aesthetic
    if (kreaRework.value && (board.aesthetic || board.name)) {
      kreaReworking.value = true
      try {
        const res = await fetch('/api/krea/rewrite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: board.name, aesthetic: board.aesthetic, keywords: board.positiveKeywords }),
        })
        if (res.ok) {
          const r = await res.json() as { name?: string | null, aesthetic?: string | null }
          if (r.name) finalName = r.name
          if (r.aesthetic) finalProfile = r.aesthetic
        }
      } catch { /* keep originals */ } finally {
        kreaReworking.value = false
      }
    }

    // Append the board's keywords verbatim. They're precise terms, so we don't
    // reword them (unlike the aesthetic prose above) — we only shuffle their
    // order before tacking them on. board.positiveKeywords is the raw list,
    // untouched by the optional rewrite.
    const keywords = (board.positiveKeywords || [])
      .map((k) => (typeof k === 'string' ? k.trim() : ''))
      .filter(Boolean)
    let aesthetic = (finalProfile || '').trim()
    if (keywords.length) {
      const tail = shuffleArray(keywords).join(', ')
      aesthetic = aesthetic ? `${aesthetic}\n\n${tail}` : tail
    }
    if (aesthetic) {
      importedAesthetic.value = aesthetic
      aestheticSource.value = 'krea'
    }
    // Prefill the LoRA name + trigger word from the (reworded) board name,
    // unless the user already set their own.
    const nameIsUntouched = !form.outputName.trim() || form.outputName.trim() === 'my_style'
    if (finalName && nameIsUntouched) form.outputName = finalName
    if (finalName && !form.triggerWord.trim()) form.triggerWord = slugifyTrigger(finalName)

    kreaBoards.value = []
    kreaOpen.value = false
    kreaBoardUrl.value = ''
    kreaJson.value = ''
  } finally {
    kreaImporting.value = false
  }
}

// ----- Drag-drop ---------------------------------------------------------

const dropZoneActive = ref(false)
function onDrop(e: DragEvent) {
  e.preventDefault()
  dropZoneActive.value = false
  addFiles(e.dataTransfer?.files)
}
function onDragOver(e: DragEvent) {
  e.preventDefault()
  dropZoneActive.value = true
}
function onDragLeave() {
  dropZoneActive.value = false
}

const fileInputRef = ref<HTMLInputElement | null>(null)

// ----- Auto-caption via server-side vision (Qwen2-VL on Replicate) --------
// Replaces the old client-built ComfyUI graph (ShowText|pysssss + a stale
// ClaudeNode schema) which /prompt rejected at validation, so it never worked.
// We downscale the image in the browser and ask /api/cloud-train/caption for a
// caption; `mode` swaps the instruction so a character's captions never
// describe the identity (that must live in the trigger word).

/** Downscale a File to a JPEG data URL (long edge ~768px) for the vision call. */
async function imageToDataUrl(file: File, maxEdge = 768): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close?.()
    return canvas.toDataURL('image/jpeg', 0.85)
  } catch {
    return null
  }
}

async function captionOne(idx: number) {
  const img = images.value[idx]
  if (!img) return
  img.captionState = 'captioning'
  try {
    const imageDataUrl = await imageToDataUrl(img.file)
    if (!imageDataUrl) throw new Error('Could not read image')
    const res = await fetch('/api/cloud-train/caption', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageDataUrl,
        mode: trainingKind.value,
        trigger: form.triggerWord,
      }),
    })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`)
    const { caption } = await res.json() as { caption?: string }
    if (caption && caption.trim()) {
      img.caption = caption.trim()
      img.captionState = 'done'
    } else {
      throw new Error('Empty caption returned')
    }
  } catch (e: any) {
    img.captionState = 'error'
    console.error('caption error', e)
  }
}

async function captionAll() {
  errorMessage.value = null
  status.value = 'captioning'
  const targets = images.value
    .map((_, i) => i)
    .filter((i) => !images.value[i]!.caption.trim())
  for (const i of targets) {
    await captionOne(i)
  }
  status.value = 'idle'
}

// ----- Build a character dataset from one reference -----------------------
// Generates a varied, consistent set via ideogram-character, then drops the
// results into the training set so the user just curates → captions → trains.

function onReferencePicked(e: Event) {
  const files = Array.from((e.target as HTMLInputElement).files ?? [])
    .filter((f) => f.type.startsWith('image/'))
  for (const file of files) {
    if (referenceFiles.value.length >= MAX_REFERENCES) break
    referenceFiles.value.push({
      file,
      previewUrl: URL.createObjectURL(file),
      includeInTraining: true,
    })
  }
  ;(e.target as HTMLInputElement).value = '' // allow re-picking the same file
}

function removeReference(idx: number) {
  const r = referenceFiles.value[idx]
  if (r) URL.revokeObjectURL(r.previewUrl)
  referenceFiles.value.splice(idx, 1)
}

/** Decode a base64 data URL into a File (to feed the same addFiles() path). */
function dataUrlToFile(dataUrl: string, name: string): File {
  const comma = dataUrl.indexOf(',')
  const head = dataUrl.slice(0, comma)
  const b64 = dataUrl.slice(comma + 1)
  const mime = head.match(/data:(.*?);base64/)?.[1] || 'image/png'
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new File([arr], name, { type: mime })
}

// Per-shot re-roll state, keyed by the image's server filename.
const regenerating = ref<Set<string>>(new Set())

/** Generate one shot from a reference data URL for a given scene. Returns a File or null. */
async function generateCharacterShot(
  refDataUrl: string,
  scene: CharacterShotScene,
  idx: number,
): Promise<File | null> {
  const subject = subjectHint.value.trim()
  const prompt = subject ? `${subject}, ${scene.prompt}` : scene.prompt
  try {
    const res = await fetch('/api/cloud-train/character-shot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        referenceImageDataUrl: refDataUrl,
        prompt,
        aspectRatio: aspectForFraming(scene.framing, idx),
      }),
    })
    if (!res.ok) return null
    const { imageDataUrl } = await res.json() as { imageDataUrl?: string }
    return imageDataUrl ? dataUrlToFile(imageDataUrl, `char_${idx}_${images.value.length}.png`) : null
  } catch {
    return null
  }
}

/** Upload a generated File and append it to the dataset, tagged for re-rolling. */
async function addGeneratedImage(file: File, scene: string) {
  try {
    const filename = await uploadImage(file)
    images.value.push({
      file, filename,
      previewUrl: URL.createObjectURL(file),
      caption: '', captionState: 'idle',
      generated: true, isReference: false, scene,
    })
  } catch { /* skip */ }
}

/** Upload a real reference photo and add it to the dataset (not generated). */
async function addReferenceToDataset(file: File) {
  try {
    const filename = await uploadImage(file)
    images.value.push({
      file, filename,
      previewUrl: URL.createObjectURL(file),
      caption: '', captionState: 'idle',
      generated: false, isReference: true, scene: '',
    })
  } catch { /* skip a failed upload */ }
}

async function buildCharacterDataset() {
  if (referenceFiles.value.length === 0 || buildingDataset.value) return
  buildError.value = null

  // Convert every reference to a data URL (capped at 1024px) for Ideogram seeding.
  const refDataUrls: string[] = []
  for (const r of referenceFiles.value) {
    const url = await imageToDataUrl(r.file, 1024)
    if (url) refDataUrls.push(url)
  }
  if (refDataUrls.length === 0) {
    buildError.value = 'Could not read the reference image(s).'
    return
  }

  buildingDataset.value = true

  // 1) Real photos flagged for training go straight into the dataset — this is
  //    what captures true body type.
  const realIncluded = referenceFiles.value.filter((r) => r.includeInTraining && !r.addedToDataset)
  for (const r of realIncluded) { await addReferenceToDataset(r.file); r.addedToDataset = true }

  // 2) Top up with synthetic variety to reach the target count.
  const target = Math.max(4, Math.min(CHARACTER_SHOT_SCENES.length + realIncluded.length, datasetCount.value || 16))
  const scenes = pickScenes(syntheticCount(target, realIncluded.length))

  buildProgress.total = scenes.length
  buildProgress.done = 0
  let made = 0

  // Small concurrency pool; each shot is independent. Seed round-robin across
  // all references (the model takes one per call), so variety uses every angle.
  const CONCURRENCY = 3
  let next = 0
  async function worker() {
    while (next < scenes.length) {
      const i = next++
      const scene = scenes[i]!
      const refUrl = refDataUrls[i % refDataUrls.length]!
      const file = await generateCharacterShot(refUrl, scene, i)
      if (file) { await addGeneratedImage(file, scene.prompt); made++ }
      buildProgress.done++
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scenes.length || 1) }, worker))

  buildingDataset.value = false
  const total = realIncluded.length + made
  if (total > 0) {
    toast.success(`Added ${total} image${total === 1 ? '' : 's'}`, {
      description: 'Curate (remove any that drifted), then caption & train.',
    })
  } else {
    buildError.value = 'No images were added — check your Replicate token and try again.'
  }
}

/** Re-roll a single generated shot in place — same scene, fresh result. */
async function regenerateShot(idx: number) {
  const img = images.value[idx]
  if (!img || !img.generated || referenceFiles.value.length === 0) return
  const key = img.filename
  if (regenerating.value.has(key)) return
  const refDataUrl = await imageToDataUrl(referenceFiles.value[0]!.file, 1024)
  if (!refDataUrl) return

  regenerating.value.add(key)
  try {
    const sceneObj: CharacterShotScene =
      CHARACTER_SHOT_SCENES.find((s) => s.prompt === img.scene) ?? { prompt: img.scene ?? '', framing: 'medium' }
    const file = await generateCharacterShot(refDataUrl, sceneObj, idx)
    if (!file) throw new Error('no image')
    const filename = await uploadImage(file)
    const target = images.value[idx]
    if (target) {
      URL.revokeObjectURL(target.previewUrl)
      target.file = file
      target.filename = filename
      target.previewUrl = URL.createObjectURL(file)
      target.caption = ''
      target.captionState = 'idle'
    }
  } catch {
    toast.error('Regenerate failed — try again')
  } finally {
    regenerating.value.delete(key)
  }
}

// ----- Training ----------------------------------------------------------

const canRun = computed(() =>
  images.value.length >= 2
  && (computeMode.value === 'cloud' || form.checkpoint)
  && form.outputName.trim().length > 0
  && status.value !== 'uploading'
  && status.value !== 'submitting'
  && status.value !== 'training'
  && status.value !== 'captioning',
)

function onStartClicked() {
  if (computeMode.value === 'cloud') startCloudTraining()
  else startTraining()
}

// Cloud trainings are queued (server-side, survive window close); local ones run
// in-process. The button reflects which.
const submitButtonLabel = computed(() => {
  if (computeMode.value === 'cloud') {
    return (status.value === 'submitting' || status.value === 'uploading') ? 'Adding…' : 'Add to queue'
  }
  return status.value === 'training' ? 'Training…' : 'Start training'
})

function buildTrainingPrompt() {
  const safeName = form.outputName.trim().replace(/[^a-zA-Z0-9_-]+/g, '_') || 'my_style'
  const prefix = `loras/${safeName}`

  // Model loading branch: SDXL/SD1.5 use one all-in-one node; Flux uses three.
  const isFlux = selectedFamily.value === 'flux'

  const modelNodes = isFlux
    ? {
        '1a': {
          class_type: 'UNETLoader',
          inputs: { unet_name: FLUX_FILES.unet, weight_dtype: 'default' },
        },
        '1b': {
          class_type: 'DualCLIPLoader',
          inputs: { clip_name1: FLUX_FILES.t5, clip_name2: FLUX_FILES.clipL, type: 'flux' },
        },
        '1c': {
          class_type: 'VAELoader',
          inputs: { vae_name: FLUX_FILES.vae },
        },
      }
    : {
        '1': {
          class_type: 'CheckpointLoaderSimple',
          inputs: { ckpt_name: form.checkpoint },
        },
      }

  // Output socket refs differ between the two paths.
  const modelRef: [string, number] = isFlux ? ['1a', 0] : ['1', 0]
  const clipRef: [string, number]  = isFlux ? ['1b', 0] : ['1', 1]
  const vaeRef: [string, number]   = isFlux ? ['1c', 0] : ['1', 2]

  return {
    ...modelNodes,
    '2': {
      class_type: 'LoadImageTextDataSetFromFolder',
      inputs: { folder: sessionFolder },
    },
    '3': {
      class_type: 'MakeTrainingDataset',
      inputs: {
        images: ['2', 0],
        vae: vaeRef,
        clip: clipRef,
        texts: ['2', 1],
      },
    },
    '4': {
      class_type: 'TrainLoraNode',
      inputs: {
        model: modelRef,
        latents: ['3', 0],
        positive: ['3', 1],
        batch_size: form.batchSize,
        grad_accumulation_steps: form.gradAccumulationSteps,
        steps: form.steps,
        learning_rate: form.learningRate,
        rank: form.rank,
        optimizer: form.optimizer,
        loss_function: form.lossFunction,
        seed: form.seed,
        training_dtype: form.trainingDtype,
        lora_dtype: form.loraDtype,
        algorithm: form.algorithm,
        gradient_checkpointing: form.gradientCheckpointing,
        checkpoint_depth: form.checkpointDepth,
        offloading: form.offloading,
        existing_lora: '[None]',
        bucket_mode: form.bucketMode,
        bypass_mode: form.bypassMode,
      },
    },
    '5': {
      class_type: 'SaveLoRA',
      inputs: {
        lora: ['4', 0],
        prefix,
        steps: ['4', 2],
      },
    },
    '6': {
      class_type: 'LossGraphNode',
      inputs: {
        loss_map: ['4', 1],
        filename_prefix: `loss_${safeName}`,
      },
    },
  }
}

async function saveCaptionsToDisk() {
  const captions: Record<string, string> = {}
  for (const img of images.value) {
    captions[img.filename] = img.caption ?? ''
  }
  const res = await fetch('/sailor/lora/save_captions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: sessionFolder, captions }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Saving captions failed: ${text || res.status}`)
  }
}

async function startTraining() {
  if (!canRun.value) return
  errorMessage.value = null
  outputFilename.value = null
  lossGraphUrl.value = null
  progressPct.value = 0

  try {
    status.value = 'submitting'
    progressLabel.value = 'Writing captions to disk…'
    await saveCaptionsToDisk()

    progressLabel.value = 'Submitting training workflow…'
    const res = await fetch('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: buildTrainingPrompt() }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || `Comfy returned ${res.status}`)
    }
    const data = await res.json()
    const promptId: string | undefined = data?.prompt_id
    if (!promptId) throw new Error('No prompt_id in response — is ComfyUI running?')

    status.value = 'training'
    progressLabel.value = `Training (0 / ${form.steps} steps)…`
    const result = await pollForTrainingResult(promptId)
    if (!result) throw new Error('Training finished but produced no output.')

    outputFilename.value = result.loraFilename
    lossGraphUrl.value = result.lossGraphUrl
    status.value = 'done'
    progressLabel.value = 'Done.'
    progressPct.value = 100
  } catch (e: any) {
    errorMessage.value = humanizeError(e?.message ?? String(e))
    status.value = 'error'
  }
}

async function pollForTrainingResult(
  promptId: string,
): Promise<{ loraFilename: string | null; lossGraphUrl: string | null } | null> {
  // No fine-grained step progress from /history — TrainLoraNode runs in one
  // execute() call. We do show a coarse running/done state via /queue.
  const deadline = Date.now() + 6 * 60 * 60 * 1000 // 6 hours
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    try {
      // Bump the progress bar so the user knows we're alive
      if (progressPct.value < 95) progressPct.value = Math.min(95, progressPct.value + 0.5)

      const r = await fetch(`/history/${promptId}`)
      if (!r.ok) continue
      const data = await r.json()
      const entry = data?.[promptId]
      if (!entry) continue
      if (entry?.status?.status_str === 'error') {
        throw new Error(extractComfyError(entry))
      }
      const outputs = entry?.outputs
      if (!outputs) continue

      let lossGraphUrl: string | null = null
      // LossGraphNode produces an image output
      for (const node of Object.values(outputs) as any[]) {
        if (Array.isArray(node?.images) && node.images.length > 0) {
          const img = node.images[0]
          lossGraphUrl = `/view?${new URLSearchParams({
            filename: img.filename,
            type: img.type,
            ...(img.subfolder ? { subfolder: img.subfolder } : {}),
            t: String(Date.now()),
          })}`
          break
        }
      }
      // We can't read the SaveLoRA filename from /history (no output declared),
      // but we know the prefix → just report the safe name.
      const safeName = form.outputName.trim().replace(/[^a-zA-Z0-9_-]+/g, '_') || 'my_style'
      return { loraFilename: safeName, lossGraphUrl }
    } catch (e) {
      if (e instanceof Error && (e.message.startsWith('Comfy:') || e.message.includes('LoRA'))) throw e
    }
  }
  return null
}

function extractComfyError(entry: any): string {
  const messages: any[] = entry?.status?.messages ?? []
  const errMsg = messages.find((m) => m[0] === 'execution_error')?.[1]
  if (errMsg?.exception_message) return `Comfy: ${errMsg.exception_message}`
  return 'Comfy: execution failed.'
}

// ----- Cloud training (Replicate) ---------------------------------------

async function buildDatasetZip(): Promise<Blob> {
  // Browser-side zip: <i>_<sanitizedName>.png + matching .txt with the caption.
  // Replicate's trainers expect image + .txt pairs (same convention as kohya).
  const zip = new JSZip()
  for (let i = 0; i < images.value.length; i++) {
    const img = images.value[i]!
    const ext = (img.file.name.split('.').pop() || 'png').toLowerCase()
    const base = String(i + 1).padStart(4, '0')
    const imgName = `${base}.${ext}`
    zip.file(imgName, img.file)
    zip.file(`${base}.txt`, img.caption || '')
  }
  return await zip.generateAsync({ type: 'blob', compression: 'STORE' })
}

/**
 * Compose up to 4 representative dataset images into one small montage so the
 * vision model reads the SET's shared aesthetic (not a single subject). Returns
 * a JPEG data URI, or null if it can't be built (non-fatal).
 */
async function buildStyleMontageDataUrl(): Promise<string | null> {
  try {
    const picks = images.value.slice(0, 4)
    if (picks.length === 0) return null
    const cell = 320
    const cols = picks.length <= 1 ? 1 : 2
    const rows = Math.ceil(picks.length / cols)
    const canvas = document.createElement('canvas')
    canvas.width = cols * cell
    canvas.height = rows * cell
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    for (let i = 0; i < picks.length; i++) {
      const bmp = await createImageBitmap(picks[i]!.file)
      const x = (i % cols) * cell
      const y = Math.floor(i / cols) * cell
      const scale = Math.max(cell / bmp.width, cell / bmp.height) // cover-fit
      const w = bmp.width * scale
      const h = bmp.height * scale
      ctx.drawImage(bmp, x + (cell - w) / 2, y + (cell - h) / 2, w, h)
      bmp.close?.()
    }
    return canvas.toDataURL('image/jpeg', 0.82)
  } catch {
    return null
  }
}

/** Ask the server to describe the dataset's aesthetic. Non-fatal: on any
 *  failure we leave cloudAesthetic null and fall back to the trigger word. */
async function generateAesthetic(): Promise<void> {
  // A Krea-imported board already carries a high-quality aesthetic — use it
  // directly and skip the (paid) Qwen vision call entirely.
  if (importedAesthetic.value) {
    cloudAesthetic.value = importedAesthetic.value
    return
  }
  try {
    const imageDataUrl = await buildStyleMontageDataUrl()
    if (!imageDataUrl) return
    const res = await fetch('/api/cloud-train/aesthetic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl }),
    })
    if (!res.ok) return
    const { aesthetic } = await res.json() as { aesthetic?: string }
    if (aesthetic) cloudAesthetic.value = aesthetic
  } catch {
    /* non-fatal */
  }
}

// Manual, button-triggered aesthetic generation for own-file datasets. Builds a
// montage of the uploaded images, asks the vision endpoint for a Krea-shaped
// taste profile (prose + keywords), and writes it into the editable field.
// Explicit (never auto) so we never fire a paid vision call without a click.
const aestheticGenerating = ref(false)
const aestheticError = ref<string | null>(null)

async function autoFillAesthetic(): Promise<void> {
  if (aestheticGenerating.value || images.value.length === 0) return
  if (
    importedAesthetic.value
    && !window.confirm('Replace the current aesthetic with one generated from your images?')
  ) return
  aestheticGenerating.value = true
  aestheticError.value = null
  try {
    const imageDataUrl = await buildStyleMontageDataUrl()
    if (!imageDataUrl) throw new Error('Could not read the uploaded images.')
    const res = await fetch('/api/cloud-train/aesthetic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl }),
    })
    if (!res.ok) throw new Error(await res.text() || `Failed (${res.status})`)
    const { aesthetic, keywords } = await res.json() as { aesthetic?: string; keywords?: string[] }
    const out = assembleAesthetic(aesthetic || '', shuffleArray(keywords || []))
    if (!out) throw new Error('The model returned an empty aesthetic.')
    importedAesthetic.value = out
    aestheticSource.value = 'images'
  } catch (e: any) {
    aestheticError.value = humanizeError(e?.message ?? String(e))
  } finally {
    aestheticGenerating.value = false
  }
}

async function startCloudTraining() {
  if (images.value.length < 2) return
  errorMessage.value = null
  outputFilename.value = null
  lossGraphUrl.value = null
  progressPct.value = 0
  cloudJob.value = null
  cloudAesthetic.value = null

  // Capture the human name now — clearDataset() runs after enqueue.
  const displayName = form.outputName.trim() || 'my style'
  const safeName = form.outputName.trim().replace(/[^a-zA-Z0-9_-]+/g, '_') || 'my_style'

  try {
    status.value = 'submitting'
    progressLabel.value = 'Zipping dataset…'
    const zipBlob = await buildDatasetZip()

    progressLabel.value = 'Uploading dataset to Replicate…'
    const fd = new FormData()
    fd.append('file', zipBlob, 'dataset.zip')
    const upRes = await fetch('/api/cloud-train/upload', { method: 'POST', body: fd })
    if (!upRes.ok) {
      const text = await upRes.text()
      throw new Error(text || `Upload failed: ${upRes.status}`)
    }
    const upJson = await upRes.json() as { url: string }

    // Analyze the dataset's aesthetic now, while we still hold the images. It's
    // stored on the job so the server can finalize the sidecar headlessly.
    progressLabel.value = 'Analyzing dataset style…'
    await generateAesthetic()

    // Hand the job to the durable server-side queue. It starts/polls/finalizes
    // independently, so closing this tab (or the whole app) no longer aborts it.
    progressLabel.value = 'Adding to the training queue…'
    const res = await fetch('/api/training-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'lora',
        datasetUrl: upJson.url,
        outputName: safeName,
        displayName,
        trigger: form.triggerWord || undefined,
        aesthetic: cloudAesthetic.value || undefined,
        loraKind: trainingKind.value === 'character' ? 'character' : 'style',
        params: {
          family: cloudFamily.value,
          steps: form.steps,
          learningRate: form.learningRate,
          loraRank: form.rank,
          batchSize: form.batchSize,
          seed: form.seed,
        },
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || `Could not queue training: ${res.status}`)
    }

    // Tell the Queue panel to refresh, then reset for the next style.
    window.dispatchEvent(new CustomEvent('sailor:trainingQueueUpdated'))
    clearDataset() // resets the form + sets status back to 'idle'
    status.value = 'queued'
    queuedName.value = displayName
    progressLabel.value = ''
  } catch (e: any) {
    errorMessage.value = humanizeError(e?.message ?? String(e))
    status.value = 'error'
  }
}

// ----- Error message normalization --------------------------------------

function humanizeError(msg: string): string {
  if (msg.includes('out of memory') || msg.includes('CUDA out of memory')) {
    return 'Out of GPU memory. Try enabling Offloading or lowering rank/batch size in Advanced.'
  }
  if (msg.includes('No prompt_id')) {
    return "Couldn't reach the engine. Is ComfyUI running on port 8188?"
  }
  if (msg.includes('LoadImageTextDataSetFromFolder')) {
    return "Couldn't load the dataset. Check that images uploaded successfully."
  }
  return msg
}

// ----- Cleanup ----------------------------------------------------------

onBeforeUnmount(() => {
  for (const img of images.value) URL.revokeObjectURL(img.previewUrl)
  for (const r of referenceFiles.value) URL.revokeObjectURL(r.previewUrl)
})
</script>

<template>
  <div class="h-full overflow-y-auto bg-[#0a0a0a]">
    <div class="max-w-[1080px] mx-auto px-10 py-12">
      <!-- Header -->
      <div class="mb-10">
        <div class="text-[11px] uppercase tracking-[0.16em] text-white/35 font-medium mb-3">
          Create · {{ kindLabel }}
        </div>
        <h1 class="text-[44px] font-medium text-white tracking-tight leading-[1.05] mb-4">
          Train a {{ kindLabel }}
        </h1>
        <p v-if="trainingKind === 'voice'" class="text-[15px] text-white/60 max-w-[640px] leading-relaxed">
          Clone a voice from a short sample. Drop in
          <span class="text-white/85">10s–5min of clean audio</span>, give it a name, and the
          cloned voice appears in the <span class="text-white/85">Generate speech</span> voice
          gallery under <span class="text-white/85">Your voices</span>.
        </p>
        <p v-else class="text-[15px] text-white/60 max-w-[640px] leading-relaxed">
          Teach a Stable Diffusion or Flux model a look or a person.
          Drop in <span class="text-white/85">10–30 reference images</span>, give it a name, and
          the trainer produces a small <code class="text-[13px] text-white/75 bg-white/[0.04] px-1 py-0.5 rounded">.safetensors</code>
          file you can load into any workflow.
        </p>
      </div>

      <!-- 1 · What are you training? — the choice that shapes everything below -->
      <section class="mb-8">
        <label class="block text-[12px] font-medium text-white/85 tracking-[0.01em] mb-2">What are you training?</label>
        <div class="grid grid-cols-3 gap-2">
          <button
            type="button"
            class="flex flex-col items-start gap-0.5 px-3.5 py-3 rounded-lg border text-left transition-colors cursor-pointer"
            :class="trainingKind === 'style'
              ? 'border-white/40 bg-white/[0.07]'
              : 'border-white/[0.08] hover:border-white/15 hover:bg-white/[0.03]'"
            @click="trainingKind = 'style'"
          >
            <span class="text-[13px] font-medium text-white">Style</span>
            <span class="text-[11px] text-white/50 leading-snug">A look across many subjects — palette, lighting, texture.</span>
          </button>
          <button
            type="button"
            class="flex flex-col items-start gap-0.5 px-3.5 py-3 rounded-lg border text-left transition-colors cursor-pointer"
            :class="trainingKind === 'character'
              ? 'border-white/40 bg-white/[0.07]'
              : 'border-white/[0.08] hover:border-white/15 hover:bg-white/[0.03]'"
            @click="trainingKind = 'character'"
          >
            <span class="text-[13px] font-medium text-white">Character</span>
            <span class="text-[11px] text-white/50 leading-snug">One person's identity — captions skip the face so the trigger owns it.</span>
          </button>
          <button
            type="button"
            class="flex flex-col items-start gap-0.5 px-3.5 py-3 rounded-lg border text-left transition-colors cursor-pointer"
            :class="trainingKind === 'voice'
              ? 'border-white/40 bg-white/[0.07]'
              : 'border-white/[0.08] hover:border-white/15 hover:bg-white/[0.03]'"
            @click="trainingKind = 'voice'"
          >
            <span class="text-[13px] font-medium text-white">Voice</span>
            <span class="text-[11px] text-white/50 leading-snug">Clone a voice from a short audio sample — use it in Generate speech.</span>
          </button>
        </div>
      </section>

      <!-- Voice cloning has its own lean flow (one prediction, no dataset). It
           replaces the entire LoRA body below. -->
      <VoiceTrainerSurface v-if="trainingKind === 'voice'" />
      <template v-else>

      <!-- Compute mode -->
      <section class="mb-8">
        <div class="flex items-center justify-between mb-2">
          <label class="text-[12px] font-medium text-white/85 tracking-[0.01em]">Compute</label>        </div>
        <div class="inline-flex rounded-lg bg-white/[0.03] border border-white/[0.06] p-0.5">
          <button
            class="inline-flex items-center gap-2 h-9 px-4 rounded-md text-[12.5px] font-medium transition-colors cursor-pointer"
            :class="computeMode === 'local'
              ? 'bg-white/[0.08] text-white'
              : 'text-white/55 hover:text-white/80'"
            @click="computeMode = 'local'"
          >
            <Cpu class="size-3.5" />
            Local
          </button>
          <button
            class="inline-flex items-center gap-2 h-9 px-4 rounded-md text-[12.5px] font-medium transition-colors cursor-pointer"
            :class="computeMode === 'cloud'
              ? 'bg-white/[0.08] text-white'
              : 'text-white/55 hover:text-white/80'"
            @click="computeMode = 'cloud'"
          >
            <Cloud class="size-3.5" />
            Cloud (Replicate)
          </button>
        </div>
        <p class="text-[11px] text-white/40 mt-2 leading-relaxed">
          <span v-if="computeMode === 'local'">Runs on this machine. Free, but slow on Apple Silicon (Flux ~8–16 hours).</span>
          <span v-else>Runs on a Replicate GPU. ~$3–5 per Flux style, ~20–40 min wall time. Requires a Replicate token (Settings → AI).</span>
        </p>
      </section>

      <!-- Cloud family picker (cloud mode only) -->
      <section v-if="computeMode === 'cloud'" class="mb-10">
        <div class="flex items-center justify-between mb-2">
          <label class="text-[12px] font-medium text-white/85 tracking-[0.01em]">Base model</label>        </div>
        <div class="grid grid-cols-2 gap-3">
          <button
            class="text-left rounded-lg border p-4 transition-colors cursor-pointer"
            :class="cloudFamily === 'flux'
              ? 'bg-white/[0.05] border-white/25'
              : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]'"
            @click="cloudFamily = 'flux'"
          >
            <div class="flex items-center justify-between mb-1">
              <span class="text-[13px] text-white font-medium">Flux Dev</span>
              <span class="text-[10px] uppercase tracking-wider text-white/40 px-1.5 py-0.5 rounded bg-white/[0.04]">FLUX</span>
            </div>
            <p class="text-[11px] text-white/45 leading-snug">Highest quality. ~$3–5 per style, ~25–40 min.</p>
          </button>
          <button
            class="text-left rounded-lg border p-4 transition-colors cursor-pointer"
            :class="cloudFamily === 'sdxl_sd15'
              ? 'bg-white/[0.05] border-white/25'
              : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]'"
            @click="cloudFamily = 'sdxl_sd15'"
          >
            <div class="flex items-center justify-between mb-1">
              <span class="text-[13px] text-white font-medium">SDXL</span>
              <span class="text-[10px] uppercase tracking-wider text-white/40 px-1.5 py-0.5 rounded bg-white/[0.04]">SDXL</span>
            </div>
            <p class="text-[11px] text-white/45 leading-snug">Faster + cheaper. ~$0.50–1 per style, ~10–15 min.</p>
          </button>
        </div>
      </section>

      <!-- Local base-model picker (local mode only) -->
      <section v-if="computeMode === 'local'" class="mb-10">
        <div class="flex items-center justify-between mb-2">
          <label class="text-[12px] font-medium text-white/85 tracking-[0.01em]">Base model</label>        </div>
        <div v-if="checkpointsLoading" class="h-10 rounded-md bg-white/[0.04] border border-white/[0.06] flex items-center px-3 text-[12px] text-white/40">
          <Loader2 class="size-3.5 animate-spin mr-2" />
          Loading checkpoints…
        </div>
        <div v-else-if="checkpointsError" class="h-10 rounded-md bg-rose-500/[0.08] border border-rose-500/30 flex items-center px-3 text-[12px] text-rose-300">
          {{ checkpointsError }}
        </div>
        <select
          v-if="checkpointOptions.length > 0"
          v-model="form.checkpoint"
          class="w-full h-10 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-3 text-[13px] text-white/85 transition-colors"
        >
          <option v-for="o in checkpointOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <div v-else>
          <div class="text-[12px] text-white/55 mb-3 leading-relaxed">
            No checkpoints found in <code class="text-white/75 bg-white/[0.04] px-1.5 py-0.5 rounded">models/checkpoints/</code>. Download one to get started — or drop your own .safetensors file in.
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div
              v-for="c in DOWNLOADABLE_CHECKPOINTS"
              :key="c.key"
              class="rounded-lg bg-white/[0.02] border border-white/[0.06] p-4 flex flex-col gap-3"
            >
              <div>
                <div class="flex items-center justify-between gap-2 mb-1">
                  <span class="text-[13px] text-white font-medium truncate">{{ c.label }}</span>
                  <span class="shrink-0 text-[11px] text-white/45 tabular-nums">{{ fmtGB(c.sizeBytes) }} GB</span>
                </div>
                <div class="flex items-center gap-2 mb-1.5">
                  <span class="text-[10px] uppercase tracking-wider text-white/40 px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.06]">{{ c.family }}</span>
                </div>
                <div class="text-[11px] text-white/45 leading-snug">{{ c.blurb }}</div>
              </div>

              <!-- Progress bar (downloading / preparing) -->
              <div v-if="downloadStates[c.key]?.phase === 'downloading' || downloadStates[c.key]?.phase === 'preparing' || downloadStates[c.key]?.phase === 'checking'" class="flex flex-col gap-1.5">
                <div class="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                  <div class="h-full bg-white/70 transition-[width] duration-300" :style="{ width: `${downloadPct(c.key)}%` }" />
                </div>
                <div class="flex items-center justify-between text-[10.5px] text-white/45 tabular-nums">
                  <span v-if="downloadStates[c.key]?.phase === 'checking'">Checking…</span>
                  <span v-else-if="downloadStates[c.key]?.phase === 'preparing'">Finishing up…</span>
                  <span v-else>{{ fmtGB(downloadStates[c.key]?.downloaded ?? 0) }} / {{ fmtGB(downloadStates[c.key]?.total ?? 0) }} GB</span>
                  <span>{{ downloadPct(c.key) }}%</span>
                </div>
              </div>

              <!-- Error -->
              <div v-else-if="downloadStates[c.key]?.phase === 'error'" class="text-[11px] text-rose-300 leading-snug">
                {{ downloadStates[c.key]?.message }}
              </div>

              <!-- Done -->
              <div v-else-if="downloadStates[c.key]?.phase === 'done'" class="text-[11px] text-emerald-400">
                Downloaded — ready to use.
              </div>

              <!-- Download button -->
              <button
                v-if="downloadStates[c.key]?.phase === 'idle' || downloadStates[c.key]?.phase === 'error'"
                class="inline-flex items-center justify-center gap-1.5 h-8 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-[12px] text-white/85 hover:text-white transition-colors cursor-pointer"
                @click="downloadCheckpoint(c.key)"
              >
                <Download class="size-3.5" />
                {{ downloadStates[c.key]?.phase === 'error' ? 'Retry' : 'Download' }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Dataset -->
      <section class="mb-10">
        <div class="flex items-center justify-between mb-2">
          <label class="text-[12px] font-medium text-white/85 tracking-[0.01em]">
            Training images
            <span class="text-white/35 font-normal ml-2">{{ images.length }} {{ images.length === 1 ? 'image' : 'images' }}</span>
            <span
              v-if="importedAesthetic"
              class="ml-2 text-[9.5px] uppercase tracking-wide text-emerald-100/90 bg-emerald-500/20 px-1.5 py-0.5 rounded align-middle"
              :title="`Aesthetic ${aestheticSource === 'krea' ? 'from Krea' : 'from your images'} (added to prompts):\n\n${importedAesthetic}`"
            >aesthetic ✓</span>
          </label>
          <div class="flex items-center gap-2">
            <button
              v-if="images.length > 0"
              class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-[11px] text-white/70 hover:text-white transition-colors cursor-pointer"
              :class="kreaOpen ? '!bg-white/[0.08] !text-white' : ''"
              @click="kreaOpen = !kreaOpen"
            >
              <Cloud class="size-3.5" />
              Import from Krea
            </button>
            <button
              v-if="images.length > 0"
              class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-[11px] text-white/70 hover:text-white transition-colors cursor-pointer"
              @click="captionAll"
              :disabled="status === 'captioning'"
            >
              <Sparkles v-if="status !== 'captioning'" class="size-3.5" />
              <Loader2 v-else class="size-3.5 animate-spin" />
              Auto-caption all
            </button>          </div>
        </div>

        <p v-if="seedLowPhotoWarning" class="mb-3 text-[12px] text-amber-300/80">
          More photos train a stronger identity — the dataset builder below can expand from one.
        </p>

        <input
          ref="fileInputRef"
          type="file"
          accept="image/*"
          multiple
          class="hidden"
          @change="(e) => addFiles((e.target as HTMLInputElement).files)"
        />

        <!-- Build a character dataset from one reference (character mode only) -->
        <div
          v-if="trainingKind === 'character'"
          class="mb-4 rounded-xl border border-white/[0.1] bg-white/[0.03] p-3"
        >
          <div class="flex items-center gap-2 mb-1">
            <Drama class="size-4 text-white/70" />
            <span class="text-[12.5px] font-medium text-white/85">Build a dataset from one photo</span>
          </div>
          <p class="text-[11px] text-white/55 leading-relaxed mb-3">
            Drop a few photos — at least one clear face close-up and one full-length shot.
            We generate <span class="text-white/75">{{ expectedShots }}</span> more to fill out the set,
            then add them below to curate &amp; train. ~${{ (expectedShots * 0.08).toFixed(2) }}.
          </p>

          <div class="flex gap-3">
            <input ref="refInputRef" type="file" accept="image/*" multiple class="hidden" @change="onReferencePicked" />
            <div class="flex flex-col gap-2">
              <div class="flex flex-wrap gap-2">
                <div
                  v-for="(r, i) in referenceFiles"
                  :key="r.previewUrl"
                  class="relative w-20 h-20 rounded-lg overflow-hidden ring-1 ring-white/10 group"
                >
                  <img :src="r.previewUrl" class="absolute inset-0 w-full h-full object-cover" />
                  <button
                    type="button"
                    class="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white/90 text-xs leading-none opacity-0 group-hover:opacity-100"
                    title="Remove"
                    @click="removeReference(i)"
                  >×</button>
                  <label
                    class="absolute bottom-0 inset-x-0 flex items-center gap-1 px-1 py-0.5 bg-black/55 text-[10px] text-white/80"
                    title="Include this real photo in the training set"
                  >
                    <input type="checkbox" v-model="r.includeInTraining" class="scale-75" />
                    <span>train</span>
                  </label>
                </div>
                <button
                  v-if="referenceFiles.length < MAX_REFERENCES"
                  type="button"
                  class="w-20 h-20 rounded-lg ring-1 ring-dashed ring-white/20 text-white/50 hover:text-white/80 hover:ring-white/40 text-2xl"
                  title="Add a reference photo"
                  @click="refInputRef?.click()"
                >+</button>
              </div>
              <p v-if="showBodyHint" class="mt-2 text-[12px] text-amber-300/80">
                Tip: keep at least one real full-length photo set to <span class="font-medium">train</span> so the
                body type is learned from a real shot, not invented.
              </p>
            </div>

            <div class="flex-1 min-w-0 space-y-2">
              <input
                v-model="subjectHint"
                type="text"
                placeholder="Optional: who is it? e.g. a young woman with red hair"
                class="w-full h-8 rounded-md bg-white/[0.04] border border-white/[0.08] focus:border-white/25 focus:outline-none px-2.5 text-[12px] text-white/85 placeholder:text-white/25"
              />
              <div class="flex items-center gap-2">
                <label class="text-[11px] text-white/50">Shots</label>
                <input
                  v-model.number="datasetCount"
                  type="number" min="8" max="24"
                  class="w-16 h-8 rounded-md bg-white/[0.04] border border-white/[0.08] focus:border-white/25 focus:outline-none px-2 text-[12px] text-white/85"
                />
                <button
                  type="button"
                  class="ml-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium transition-colors"
                  :class="referenceFiles.length && !buildingDataset
                    ? 'bg-emerald-500/90 hover:bg-emerald-400 text-black cursor-pointer'
                    : 'bg-white/[0.06] text-white/35 cursor-not-allowed'"
                  :disabled="!referenceFiles.length || buildingDataset"
                  @click="buildCharacterDataset"
                >
                  <Loader2 v-if="buildingDataset" class="size-3.5 animate-spin" />
                  <Sparkles v-else class="size-3.5" />
                  {{ buildingDataset ? `Generating ${buildProgress.done}/${buildProgress.total}…` : 'Generate dataset' }}
                </button>
              </div>
              <div v-if="buildingDataset" class="h-1 rounded-full bg-white/[0.08] overflow-hidden">
                <div
                  class="h-full bg-emerald-400 transition-all duration-300"
                  :style="{ width: `${buildProgress.total ? (buildProgress.done / buildProgress.total * 100) : 0}%` }"
                />
              </div>
              <p v-if="buildError" class="text-[10.5px] text-rose-300">{{ buildError }}</p>
            </div>
          </div>
        </div>

        <!-- (Krea importer moved below, after the drop zone — see "Start from a Krea moodboard") -->

        <!-- What makes a good dataset (only when empty, before drop zone) -->
        <div v-if="images.length === 0" class="mb-3 rounded-lg bg-white/[0.02] border border-white/[0.05] px-4 py-3">
          <div class="text-[11.5px] text-white/75 font-medium mb-1.5">What makes a good dataset</div>
          <ul class="text-[11.5px] text-white/55 leading-relaxed space-y-0.5 list-disc list-inside marker:text-white/25">
            <li><span class="text-white/75">10–30 images</span> — more isn't always better; quality &gt; quantity.</li>
            <li><span class="text-white/75">Varied angles + lighting</span> — same subject, different shots. Don't use 20 near-duplicates.</li>
            <li><span class="text-white/75">Square-ish framing</span> works best; the trainer will resize to a square crop.</li>
            <li>For characters/people: include close-ups, mid-shots, and full-body shots.</li>
          </ul>
        </div>

        <!-- Drop zone (empty state) -->
        <div
          v-if="images.length === 0"
          class="group relative aspect-[16/7] rounded-xl border border-dashed transition-colors flex flex-col items-center justify-center gap-3 cursor-pointer"
          :class="dropZoneActive
            ? 'border-white/30 bg-white/[0.05]'
            : 'border-white/12 bg-white/[0.015] hover:bg-white/[0.04] hover:border-white/25'"
          @click="fileInputRef?.click()"
          @dragover="onDragOver"
          @dragleave="onDragLeave"
          @drop="onDrop"
        >
          <div class="size-12 rounded-full bg-white/[0.04] flex items-center justify-center">
            <Upload class="size-5 text-white/45 group-hover:text-white/70 transition-colors" :stroke-width="1.5" />
          </div>
          <div class="text-center">
            <div class="text-[14px] text-white/75 mb-1">Drop your reference images</div>
            <div class="text-[11px] text-white/35">or click to browse · PNG, JPG, WebP</div>
          </div>
        </div>

        <!-- Start from a Krea moodboard — first-class entry point (always shown when empty) -->
        <div v-if="kreaOpen || images.length === 0">
          <div v-if="images.length === 0" class="flex items-center gap-3 my-4">
            <div class="h-px flex-1 bg-white/[0.08]" />
            <span class="text-[10.5px] uppercase tracking-[0.14em] text-white/30">or start from a Krea moodboard</span>
            <div class="h-px flex-1 bg-white/[0.08]" />
          </div>

          <div class="rounded-xl bg-white/[0.03] border border-white/[0.1] p-4 space-y-3">
            <div class="flex items-start gap-2.5">
              <div class="size-8 rounded-lg bg-white/[0.08] flex items-center justify-center shrink-0">
                <Cloud class="size-4 text-white/70" />
              </div>
              <div class="min-w-0">
                <div class="text-[12.5px] font-medium text-white">Import a Krea moodboard</div>
                <p class="text-[11px] text-white/50 leading-relaxed mt-0.5">
                  Paste a public moodboard URL (any board you can browse). Its images and aesthetic
                  import automatically — no login, no DevTools.
                </p>
              </div>
            </div>

            <!-- Primary: paste a public board URL -->
            <div class="flex items-center gap-2">
              <input
                v-model="kreaBoardUrl"
                type="text"
                placeholder="https://www.krea.ai/moodboard-feed/…"
                class="flex-1 h-9 px-3 rounded-md bg-black/30 border border-white/10 text-[12px] text-white/85 placeholder:text-white/25 focus:outline-none focus:border-white/30"
                @keydown.enter="fetchKreaBoard"
              />
              <button
                class="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-emerald-500/90 hover:bg-emerald-400 text-[12px] font-medium text-black transition-colors cursor-pointer disabled:opacity-50"
                :disabled="!kreaBoardUrl.trim() || kreaFetching"
                @click="fetchKreaBoard"
              >
                <Loader2 v-if="kreaFetching" class="size-3.5 animate-spin" />
                Fetch board
              </button>
            </div>

            <!-- Make it original: AI rename + reword on import -->
            <label class="flex items-start gap-2 cursor-pointer select-none">
              <input v-model="kreaRework" type="checkbox" class="mt-0.5 accent-white cursor-pointer" />
              <span class="text-[10.5px] text-white/55 leading-relaxed">
                <span class="text-white/75">Make it original</span> — rename the board and reword the
                aesthetic with AI so it's inspired by the reference, not a copy.
              </span>
            </label>

            <!-- Fallback: paste JSON for a private board you own -->
            <div>
              <button
                class="text-[10.5px] text-white/40 hover:text-white/70 inline-flex items-center gap-1 cursor-pointer transition-colors"
                @click="kreaShowJson = !kreaShowJson"
              >
                <ChevronRight class="size-3 transition-transform" :class="kreaShowJson ? 'rotate-90' : ''" />
                Importing a private board you own? Paste its JSON
              </button>
              <div v-if="kreaShowJson" class="mt-2 space-y-2 pl-1 border-l border-white/[0.06]">
                <ol class="text-[10.5px] text-white/45 leading-relaxed list-decimal list-inside marker:text-white/25 space-y-0.5 pl-1">
                  <li>Open the board on krea.ai → DevTools (<span class="text-white/65">⌥⌘I</span>) → <span class="text-white/65">Network</span>.</li>
                  <li>Reload; click the <code class="text-white/70 bg-white/[0.05] px-1 rounded">moodboards</code> request → right-click → <span class="text-white/65">Copy → Copy Response</span>.</li>
                </ol>
                <textarea
                  v-model="kreaJson"
                  rows="3"
                  placeholder='Paste the moodboard JSON here — e.g. [{"name":"…","images":[…],"tasteProfile":"…"}]'
                  class="w-full px-2.5 py-2 rounded-md bg-black/30 border border-white/10 text-[11px] font-mono text-white/85 placeholder:text-white/25 focus:outline-none focus:border-white/30 resize-y"
                />
                <div class="flex justify-end">
                  <button
                    class="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-[11px] text-white/85 transition-colors cursor-pointer disabled:opacity-50"
                    :disabled="!kreaJson.trim() || kreaImporting"
                    @click="parseKreaJson"
                  >
                    Load from JSON
                  </button>
                </div>
              </div>
            </div>

            <p v-if="kreaError" class="text-[10.5px] text-red-300/90">{{ kreaError }}</p>

            <!-- Board picker -->
            <div v-if="kreaBoards.length" class="space-y-1.5 pt-0.5">
              <div class="text-[10.5px] text-white/40">Pick a board to load its images:</div>
              <div class="grid grid-cols-3 gap-2">
                <button
                  v-for="b in kreaBoards"
                  :key="b.id || b.name"
                  class="group relative rounded-lg border border-white/[0.08] hover:border-white/25 overflow-hidden text-left transition-colors cursor-pointer disabled:opacity-50"
                  :disabled="kreaImporting"
                  :title="b.aesthetic || ''"
                  @click="importKreaBoard(b)"
                >
                  <div class="flex gap-px h-16 bg-black/40">
                    <img
                      v-for="(p, i) in b.previewImages.slice(0, 3)"
                      :key="i"
                      :src="`/api/krea/image?url=${encodeURIComponent(p)}`"
                      class="flex-1 min-w-0 object-cover"
                      loading="lazy"
                    />
                  </div>
                  <div class="p-2">
                    <div class="text-[11px] font-medium text-white truncate">{{ b.name }}</div>
                    <div class="text-[9.5px] text-white/45 truncate">
                      <template v-if="b.loadedImages && b.loadedImages < b.imageCount">{{ b.loadedImages }} of {{ b.imageCount }} images</template>
                      <template v-else>{{ b.imageCount }} {{ b.imageCount === 1 ? 'image' : 'images' }}</template>
                      <span v-if="b.aesthetic" class="text-emerald-300/80"> · aesthetic ✓</span>
                    </div>
                  </div>
                </button>
              </div>
            </div>

            <div v-if="kreaImporting" class="text-[10.5px] text-white/55 flex items-center gap-1.5">
              <Loader2 class="size-3.5 animate-spin" />
              {{ kreaReworking ? 'Reworking the style with AI…' : 'Downloading images…' }}
            </div>
          </div>
        </div>

        <!-- Image grid + caption hint (shown only with images) -->
        <template v-if="images.length > 0">
          <p class="text-[11px] text-white/45 mb-3 leading-relaxed">
            Write a short caption per image describing what's in it — these teach the model what the
            trigger word should mean. Click <span class="text-white/65 inline-flex items-center gap-0.5"><Sparkles class="size-3 inline" />Auto-caption all</span>
            to fill empty ones with Claude vision.
          </p>
          <div
            class="grid grid-cols-3 gap-3"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
            @drop="onDrop"
          >
          <div
            v-for="(img, idx) in images"
            :key="img.previewUrl"
            class="relative rounded-lg overflow-hidden bg-black border border-white/10 group"
          >
            <div class="aspect-square relative">
              <img :src="img.previewUrl" class="absolute inset-0 size-full object-cover" />
              <button
                class="absolute top-1.5 right-1.5 size-6 rounded-full bg-black/70 hover:bg-black/90 backdrop-blur-sm flex items-center justify-center text-white/80 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                @click="removeImage(idx)"
              >
                <X class="size-3" />
              </button>
              <!-- Re-roll a generated shot (character dataset only) -->
              <button
                v-if="img.generated && referenceFiles.length"
                class="absolute top-1.5 right-9 size-6 rounded-full bg-black/70 hover:bg-white/20 backdrop-blur-sm flex items-center justify-center text-white/80 hover:text-white transition-opacity cursor-pointer disabled:cursor-wait"
                :class="regenerating.has(img.filename) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
                title="Regenerate this shot"
                :disabled="regenerating.has(img.filename)"
                @click="regenerateShot(idx)"
              >
                <Loader2 v-if="regenerating.has(img.filename)" class="size-3 animate-spin" />
                <RefreshCcw v-else class="size-3" />
              </button>
              <!-- Caption state pill -->
              <div
                v-if="img.captionState === 'captioning'"
                class="absolute top-1.5 left-1.5 inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-black/70 backdrop-blur-sm text-[10px] text-white/80"
              >
                <Loader2 class="size-2.5 animate-spin" />
                Captioning
              </div>
              <div
                v-else-if="img.captionState === 'done'"
                class="absolute top-1.5 left-1.5 inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-emerald-500/80 backdrop-blur-sm text-[10px] text-white"
              >
                Auto
              </div>
              <div
                v-else-if="img.captionState === 'error'"
                class="absolute top-1.5 left-1.5 inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-rose-500/80 backdrop-blur-sm text-[10px] text-white"
              >
                Failed
              </div>
            </div>
            <div class="p-2 bg-white/[0.02] border-t border-white/[0.04]">
              <textarea
                v-model="img.caption"
                rows="2"
                placeholder="Describe this image…"
                class="w-full bg-transparent text-[11.5px] text-white/85 placeholder:text-white/25 resize-none focus:outline-none leading-snug"
              />
              <button
                class="text-[10px] text-white/40 hover:text-white/70 transition-colors cursor-pointer inline-flex items-center gap-1"
                @click="captionOne(idx)"
                :disabled="img.captionState === 'captioning'"
              >
                <Sparkles class="size-2.5" />
                {{ img.caption ? 'Re-caption' : 'Auto-caption' }}
              </button>
            </div>
          </div>

          <!-- Add more tile -->
          <button
            class="aspect-square rounded-lg border border-dashed border-white/12 hover:border-white/25 bg-white/[0.015] hover:bg-white/[0.04] flex flex-col items-center justify-center gap-2 text-white/45 hover:text-white/70 transition-colors cursor-pointer"
            @click="fileInputRef?.click()"
          >
            <Plus class="size-5" :stroke-width="1.5" />
            <span class="text-[11px]">Add images</span>
          </button>
          </div>
        </template>
      </section>

      <!-- Details -->
      <section class="mb-6">
        <div class="flex items-center justify-between mb-3">
          <label class="text-[12px] font-medium text-white/85 tracking-[0.01em]">Details</label>
        </div>

        <div class="space-y-5">
          <!-- LoRA name -->
          <div>
            <label class="block text-[12px] font-medium text-white/80 mb-1">{{ kindLabel }} name</label>
            <p class="text-[11px] text-white/45 mb-2 leading-relaxed">
              What to call the trained file. Saved as <code class="text-white/65 bg-white/[0.04] px-1 py-0.5 rounded">models/loras/&lt;name&gt;.safetensors</code>.
            </p>
            <input
              v-model="form.outputName"
              type="text"
              placeholder="e.g. julien_portrait_v1"
              class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-3 text-[13px] text-white/85 placeholder:text-white/25"
            />
          </div>

          <!-- Trigger word -->
          <div>
            <label class="block text-[12px] font-medium text-white/80 mb-1">
              Trigger word
              <span class="text-white/35 font-normal ml-1">optional</span>
            </label>
            <p class="text-[11px] text-white/45 mb-2 leading-relaxed">
              A rare word that "activates" this {{ kindNoun }} when used in a prompt. Pick something that wouldn't normally show up in captions —
              <code class="text-white/65 bg-white/[0.04] px-1 py-0.5 rounded">ohwx</code>,
              <code class="text-white/65 bg-white/[0.04] px-1 py-0.5 rounded">sks</code>, or a made-up token like
              <code class="text-white/65 bg-white/[0.04] px-1 py-0.5 rounded">jln_2026</code> work well.
            </p>
            <input
              v-model="form.triggerWord"
              type="text"
              placeholder="e.g. ohwx"
              class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-3 text-[13px] text-white/85 placeholder:text-white/25"
            />
          </div>

          <!-- Aesthetic — shown after a Krea import OR once own images exist -->
          <div v-if="importedAesthetic !== null">
            <div class="flex items-center justify-between mb-1">
              <label class="block text-[12px] font-medium text-white/80">
                Aesthetic
                <span class="text-white/55 font-normal ml-1">added to your prompts</span>
              </label>
              <button
                v-if="aestheticSource === 'images'"
                type="button"
                class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-[11px] text-white/70 hover:text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
                :disabled="aestheticGenerating || images.length === 0"
                @click="autoFillAesthetic"
              >
                <Loader2 v-if="aestheticGenerating" class="size-3.5 animate-spin" />
                <Wand v-else class="size-3.5" />
                {{ aestheticGenerating ? 'Reading images…' : 'Auto-fill from images' }}
              </button>
            </div>
            <p class="text-[11px] text-white/45 mb-2 leading-relaxed">
              A short style description prepended to prompts when you use this style, so generations match the look.
              <template v-if="aestheticSource === 'krea'">
                Imported from your Krea moodboard<span v-if="kreaRework"> and reworded to be original</span> — edit freely.
              </template>
              <template v-else>
                Describe the aesthetic, or auto-fill it from your uploaded images — edit freely.
              </template>
            </p>
            <textarea
              v-model="importedAesthetic"
              rows="4"
              placeholder="Describe the aesthetic — color, texture, light, composition…"
              class="w-full rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-3 py-2 text-[12.5px] leading-relaxed text-white/85 placeholder:text-white/25 resize-y"
            />
            <p v-if="aestheticError" class="text-[11px] text-rose-300/80 mt-1">{{ aestheticError }}</p>
            <p v-else class="text-[10.5px] text-white/30 mt-1">{{ (importedAesthetic || '').trim().split(/\s+/).filter(Boolean).length }} words</p>
          </div>

          <!-- Training knobs — collapsed; the defaults work for most runs -->
          <div>
            <button
              type="button"
              class="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-white/45 hover:text-white/75 cursor-pointer transition-colors"
              @click="advancedSettingsOpen = !advancedSettingsOpen"
            >
              <ChevronRight class="size-3 transition-transform" :class="advancedSettingsOpen ? 'rotate-90' : ''" />
              Advanced settings
              <span class="normal-case tracking-normal text-white/30 ml-1">steps · learning rate · rank</span>
            </button>
            <div v-if="advancedSettingsOpen" class="grid grid-cols-3 gap-4 mt-3">
            <div>
              <label class="block text-[12px] font-medium text-white/80 mb-1">Training steps</label>
              <p class="text-[11px] text-white/45 mb-2 leading-relaxed">
                More = better fit, longer training.
                <span class="text-white/65">500</span> is a safe default;
                <span class="text-white/65">1000–2000</span> for tricky subjects.
              </p>
              <input
                v-model.number="form.steps"
                type="number"
                min="1"
                max="100000"
                class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-3 text-[13px] text-white/85"
              />
            </div>
            <div>
              <label class="block text-[12px] font-medium text-white/80 mb-1">Learning rate</label>
              <p class="text-[11px] text-white/45 mb-2 leading-relaxed">
                How fast the model adapts.
                <span class="text-white/65">0.0004</span> is the Flux default; lower for delicate styles.
              </p>
              <input
                v-model.number="form.learningRate"
                type="number"
                step="0.0001"
                min="0.0000001"
                max="1"
                class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-3 text-[13px] text-white/85"
              />
            </div>
            <div>
              <label class="block text-[12px] font-medium text-white/80 mb-1">
                LoRA size
                <span class="text-white/35 font-normal ml-1">rank</span>
              </label>
              <p class="text-[11px] text-white/45 mb-2 leading-relaxed">
                Higher = more capacity + bigger file.
                <span class="text-white/65">32</span> is the sweet spot;
                <span class="text-white/65">64</span> for complex subjects.
              </p>
              <input
                v-model.number="form.rank"
                type="number"
                min="1"
                max="128"
                class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-3 text-[13px] text-white/85"
              />
            </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Cost + time estimate (cloud mode only) -->
      <section v-if="computeMode === 'cloud'" class="mb-6">
        <div class="rounded-lg bg-gradient-to-br from-white/[0.05] to-white/[0.02] border border-white/15 p-4 flex items-center gap-4">
          <div class="size-9 rounded-full bg-white/[0.12] flex items-center justify-center shrink-0">
            <Cloud class="size-4 text-white/70" :stroke-width="1.75" />
          </div>
          <div class="flex-1">
            <div class="text-[12.5px] text-white/85 mb-0.5">
              <span class="font-medium">Estimated {{ totalEstimate.hasDataset ? 'training cost' : 'cost' }}: {{ costEstimate.cost }}</span>
              <span class="text-white/45"> · {{ costEstimate.time }}</span>
            </div>
            <div v-if="totalEstimate.hasDataset" class="text-[12px] text-white/70 mb-0.5">
              + dataset {{ totalEstimate.datasetCost }} ({{ plannedDatasetCount }} shots) ·
              <span class="font-medium text-white">total {{ totalEstimate.total }}</span>
            </div>
            <p class="text-[11px] text-white/50 leading-relaxed">
              Billed to your Replicate account. {{ costEstimate.note }}
            </p>
          </div>
        </div>
      </section>

      <!-- Advanced disclosure (local mode only — Replicate doesn't expose these knobs) -->
      <section v-if="computeMode === 'local'" class="mb-10">
        <button
          class="inline-flex items-center gap-1.5 text-[12px] text-white/55 hover:text-white/85 transition-colors cursor-pointer mb-3"
          @click="advancedOpen = !advancedOpen"
        >
          <ChevronDown v-if="advancedOpen" class="size-3.5" />
          <ChevronRight v-else class="size-3.5" />
          Local engine settings
          <span class="text-white/30 ml-1">optimizer · loss · dtype</span>
        </button>
        <div v-if="advancedOpen" class="grid grid-cols-3 gap-3 p-4 rounded-lg bg-white/[0.02] border border-white/[0.05]">
          <div>
            <label class="block text-[11px] text-white/50 mb-1.5">Optimizer</label>
            <select v-model="form.optimizer" class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-2 text-[12px] text-white/85">
              <option>AdamW</option><option>Adam</option><option>SGD</option><option>RMSprop</option>
            </select>
          </div>
          <div>
            <label class="block text-[11px] text-white/50 mb-1.5">Loss function</label>
            <select v-model="form.lossFunction" class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-2 text-[12px] text-white/85">
              <option>MSE</option><option>L1</option><option>Huber</option><option>SmoothL1</option>
            </select>
          </div>
          <div>
            <label class="block text-[11px] text-white/50 mb-1.5">Algorithm</label>
            <input v-model="form.algorithm" type="text" class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-2 text-[12px] text-white/85" />
          </div>
          <div>
            <label class="block text-[11px] text-white/50 mb-1.5">Batch size</label>
            <input v-model.number="form.batchSize" type="number" min="1" class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-2 text-[12px] text-white/85" />
          </div>
          <div>
            <label class="block text-[11px] text-white/50 mb-1.5">Grad accum steps</label>
            <input v-model.number="form.gradAccumulationSteps" type="number" min="1" class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-2 text-[12px] text-white/85" />
          </div>
          <div>
            <label class="block text-[11px] text-white/50 mb-1.5">Seed</label>
            <input v-model.number="form.seed" type="number" min="0" class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-2 text-[12px] text-white/85" />
          </div>
          <div>
            <label class="block text-[11px] text-white/50 mb-1.5">Training dtype</label>
            <select v-model="form.trainingDtype" class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-2 text-[12px] text-white/85">
              <option>bf16</option><option>fp32</option><option>none</option>
            </select>
          </div>
          <div>
            <label class="block text-[11px] text-white/50 mb-1.5">Weights dtype</label>
            <select v-model="form.loraDtype" class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-2 text-[12px] text-white/85">
              <option>bf16</option><option>fp32</option>
            </select>
          </div>
          <div>
            <label class="block text-[11px] text-white/50 mb-1.5">Checkpoint depth</label>
            <input v-model.number="form.checkpointDepth" type="number" min="1" max="5" class="w-full h-9 rounded-md bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-white/25 focus:outline-none px-2 text-[12px] text-white/85" />
          </div>
          <label class="flex items-center gap-2 col-span-3 text-[12px] text-white/70 mt-2">
            <input v-model="form.gradientCheckpointing" type="checkbox" class="accent-white" />
            Gradient checkpointing (slower per step, much less VRAM)
          </label>
          <label class="flex items-center gap-2 col-span-3 text-[12px] text-white/70">
            <input v-model="form.offloading" type="checkbox" class="accent-white" />
            CPU offload model weights (saves VRAM, slower)
          </label>
          <label class="flex items-center gap-2 col-span-3 text-[12px] text-white/70">
            <input v-model="form.bucketMode" type="checkbox" class="accent-white" />
            Resolution bucket mode
          </label>
          <label class="flex items-center gap-2 col-span-3 text-[12px] text-white/70">
            <input v-model="form.bypassMode" type="checkbox" class="accent-white" />
            Bypass mode (for quantized models)
          </label>
        </div>
      </section>

      <!-- Run -->
      <div class="flex items-center justify-between mb-12">
        <div class="text-[12px]">
          <p v-if="status === 'training' || status === 'submitting' || status === 'captioning'" class="text-white/65 flex items-center gap-2">
            <Loader2 class="size-3.5 animate-spin" />
            <span>{{ progressLabel }}</span>
          </p>
          <p v-else-if="status === 'uploading'" class="text-white/65 flex items-center gap-2">
            <Loader2 class="size-3.5 animate-spin" />
            <span>Uploading…</span>
          </p>
          <p v-else-if="errorMessage" class="text-rose-400 max-w-md">{{ errorMessage }}</p>
          <p v-else-if="status === 'done'" class="text-emerald-400 flex items-center gap-2">
            <span>Done — your Style was saved.</span>
          </p>
          <p v-else-if="status === 'queued'" class="text-emerald-400 flex items-center gap-2">
            <Check class="size-3.5" />
            <span>“{{ queuedName }}” added to the queue — it’ll keep training even if you close this. Track it in the Queue panel.</span>
          </p>
          <span v-else class="text-white/35">
            {{
              images.length < 2
                ? 'Add at least 2 images to start.'
                : computeMode === 'local' && !form.checkpoint
                  ? 'Select a base model.'
                  : computeMode === 'cloud'
                    ? `Ready to queue on Replicate (${cloudFamily === 'flux' ? 'Flux Dev' : 'SDXL'}).`
                    : 'Ready to train.'
            }}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <button
            v-if="images.length > 0 && status !== 'training'"
            class="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-[12px] text-white/70 hover:text-white transition-colors cursor-pointer"
            @click="clearDataset"
          >
            <RefreshCcw class="size-3.5" />
            Clear
          </button>
          <button
            class="inline-flex items-center gap-2 h-10 px-5 rounded-full bg-white text-[#0a0a0a] font-medium text-[13px] hover:bg-white/90 transition-colors cursor-pointer disabled:bg-white/15 disabled:text-white/40 disabled:cursor-not-allowed"
            :disabled="!canRun"
            @click="onStartClicked"
          >
            <span>{{ submitButtonLabel }}</span>
            <ArrowRight v-if="status !== 'training' && status !== 'submitting' && status !== 'uploading'" class="size-4" />
            <Loader2 v-else class="size-4 animate-spin" />
          </button>
        </div>
      </div>

      <!-- Progress bar (during training) -->
      <div v-if="status === 'training'" class="mb-12">
        <div class="h-1 rounded-full bg-white/[0.06] overflow-hidden">
          <div class="h-full bg-white/70 transition-[width] duration-700" :style="{ width: `${progressPct}%` }" />
        </div>
        <p class="text-[11px] text-white/35 mt-2">
          <span v-if="computeMode === 'local'">Training runs in-process and can take many minutes. Leave this tab open.</span>
          <span v-else>Training is running on Replicate's GPUs (~20–40 min for Flux, ~10–15 min for SDXL). Keep this tab open so we can auto-download the Style when it's done.</span>
        </p>
      </div>

      <!-- Output -->
      <div v-if="status === 'done' || lossGraphUrl" class="border-t border-white/[0.06] pt-10">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-[20px] font-medium text-white tracking-tight">Result</h2>
        </div>
        <div v-if="outputFilename" class="rounded-xl bg-white/[0.02] border border-white/[0.06] p-5 mb-4">
          <div class="text-[11px] text-white/40 uppercase tracking-wider mb-2">Style saved</div>
          <div class="text-[15px] text-white font-mono mb-1">
            <span v-if="cloudJob?.localFilename">{{ cloudJob.localFilename }}</span>
            <span v-else>{{ outputFilename }}_*.safetensors</span>
          </div>
          <div v-if="computeMode === 'cloud' && cloudJob?.localFilename" class="text-[11px] text-white/45">
            Saved to <code class="text-white/65 bg-white/[0.04] px-1 py-0.5 rounded">models/loras/</code> — ready to use in workflows.
          </div>
          <div v-else class="text-[11px] text-white/45">
            Saved under output/loras/. Move or symlink to models/loras/ to use in workflows.
          </div>
          <a
            v-if="cloudJob?.replicateUrl"
            :href="cloudJob.replicateUrl"
            target="_blank"
            rel="noopener"
            class="mt-3 inline-flex items-center gap-1.5 text-[11.5px] text-white/55 hover:text-white/85 transition-colors"
          >
            <Cloud class="size-3" />
            Also available on Replicate's CDN ↗
          </a>
          <div v-if="cloudJob?.localFilename" class="mt-4 pt-4 border-t border-white/[0.06]">
            <button
              class="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-white text-black text-[13px] font-medium hover:bg-white/90 transition-colors cursor-pointer"
              @click="useTrainedLoraInWorkflow"
            >
              <Sparkles class="size-4" />
              Use in new workflow
              <ArrowRight class="size-4" />
            </button>
            <p class="text-[11px] text-white/40 mt-2">
              Opens a Flux generator with this Style<span v-if="form.triggerWord"> and your trigger word</span> ready to run.
            </p>
          </div>
        </div>
        <div v-if="lossGraphUrl" class="rounded-xl overflow-hidden bg-black border border-white/[0.06]">
          <img :src="lossGraphUrl" class="w-full max-h-[420px] object-contain" />
        </div>

        <!-- Replicate logs tail (cloud mode) -->
        <details v-if="computeMode === 'cloud' && cloudJob?.logs" class="mt-3">
          <summary class="text-[11px] text-white/45 hover:text-white/70 cursor-pointer">View Replicate logs</summary>
          <pre class="mt-2 text-[10.5px] text-white/55 bg-black/40 border border-white/[0.06] rounded p-3 max-h-[240px] overflow-auto font-mono whitespace-pre-wrap">{{ cloudJob.logs }}</pre>
        </details>
      </div>
      </template>
    </div>
  </div>
</template>
