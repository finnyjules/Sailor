<!-- frontend/app/components/vue-canvas/CollectionDrawer.vue -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import JSZip from 'jszip'
import { X, Plus, Upload, ClipboardPaste, Trash2, Play, Check, ImagePlus, Loader2, Link2 } from 'lucide-vue-next'
import { deriveOutputs } from '~~/shared/template-grid/resolve'
import { BINDINGS_PROP, COLLECTION_PROP, type CollectionData, type CollectionRow, type VarBinding, type VariableType } from '~/lib/collection/types'
import { addColumn, addRow, removeColumn, removeRow, setCell, clampPreviewRow, rowLabel, keepRow } from '~/lib/collection/model'
import { importTable } from '~/lib/collection/parse'
import { IMAGE_ACCEPT, uploadMediaFile, addMediaRows } from '~/lib/collection/upload'
import { readTemplateFromNode } from '~/lib/collection/bindables'
import { VARS_TARGET_NODE_TYPES } from '~/lib/collection/varsInput'
import { validateRun } from '~/lib/collection/resolve'
import { wiredTargets, pushVarPreview } from '~/lib/collection/preview'
import { planBatch, runBatch, type BatchItem, type BatchStatus } from '~/lib/collection/batch'
import { buildRenderItem, buildStudioRenderItem, estimateBatch, sanitize } from '~/lib/collection/generate'
import { getStudioParamBaker } from '~/lib/studio/cascade'
import { linkedColumns, resolveLinkedCell, makeLookupResolver } from '~/lib/collection/lookup'
import { isImageUrl } from '~/lib/collection/isImageUrl'

const props = defineProps<{
  nodeId: string
  nodes: any[]
  edges: any[]
  pendingSweep?: { collectionNodeId: string; rowIds: string[]; targetNodeId: string } | null
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'sweep-consumed'): void }>()

const node = computed(() => props.nodes.find(n => String(n.id) === String(props.nodeId)))
const collection = computed<CollectionData | null>(() =>
  (node.value?.data?.properties?.[COLLECTION_PROP] as CollectionData) ?? null)

const TYPES: VariableType[] = ['text', 'color', 'number', 'image', 'font', 'select']

// --- Lookup (linked) columns — read-only, contributed by this collection's
// links into foreign collections. Rendered after the real columns, never
// editable here (edit at the source via `openForeign`).
const lookupResolve = computed(() => makeLookupResolver(props.nodes))
const linkedCols = computed(() => (collection.value ? linkedColumns(collection.value, lookupResolve.value) : []))
function linkedCellText(rowIndex: number, colIndex: number): string {
  const c = collection.value; const col = linkedCols.value[colIndex]
  if (!c || !col) return ''
  const v = resolveLinkedCell(c, rowIndex, col, lookupResolve.value)
  return v === undefined ? '—' : String(v)
}
function openForeign(sourceCollectionId: string) {
  const n = props.nodes.find((x: any) => x?.data?.properties?.[COLLECTION_PROP]?.id === sourceCollectionId)
  if (n) window.dispatchEvent(new CustomEvent('sailor:openCollection', { detail: { nodeId: String(n.id) } }))
}

// --- Wired targets --------------------------------------------------------
// Smart Layout / studio targets wired from this collection's output-0, used to
// push the live preview row and to drive the batch run. Binding itself is
// created in the target's own UI (the pink variable hexagon on each control),
// never here: a single column can drive multiple controls, so bindings live on
// the controls, not in a per-column matrix in this drawer. We only act on the
// first wired target; multiple targets on one collection is an edge case the
// UI doesn't solve for yet.
const targets = computed(() => wiredTargets(props.nodeId, props.nodes, props.edges)
  .filter(n => VARS_TARGET_NODE_TYPES.has(n?.data?.nodeType)))
const target = computed(() => targets.value[0] ?? null)

function targetBindings(): Record<string, VarBinding> {
  if (!target.value) return {}
  if (!target.value.data.properties) target.value.data.properties = {}
  if (!target.value.data.properties[BINDINGS_PROP]) target.value.data.properties[BINDINGS_PROP] = {}
  return target.value.data.properties[BINDINGS_PROP]
}

// Live preview: any change to the collection (cells, preview row) or to the
// bindings themselves re-pushes the resolved preview row onto the target.
// Must never deep-watch the whole target properties object — VAR_PREVIEW_PROP
// and BINDINGS_PROP have to stay disjoint watched keys, or writes to
// sailor_varPreview below would retrigger this watcher (infinite loop).
watch(
  [collection, () => target.value?.data?.properties?.[BINDINGS_PROP]],
  () => { if (node.value) pushVarPreview(node.value, targets.value, props.nodes) },
  { deep: true, immediate: true },
)

// --- Generate ---------------------------------------------------------
const outputs = computed(() => {
  if (!target.value) return []
  const template = readTemplateFromNode(target.value)
  if (!template) return []
  try { return deriveOutputs(template as any) } catch { return [] }
})
const generateN = computed(() => (collection.value?.rows.length ?? 0) * outputs.value.length)

const confirmOpen = ref(false)
const items = ref<BatchItem[]>([])
const running = ref(false)
const runSignal = ref<{ cancelled: boolean } | null>(null)

const estimate = computed(() => estimateBatch(generateN.value))
const warnings = computed(() => (collection.value ? validateRun(collection.value, targetBindings()) : []))
const warningsShown = computed(() => warnings.value.slice(0, 5))
const warningsMore = computed(() => Math.max(0, warnings.value.length - 5))

const STATUS_RANK: Record<BatchStatus, number> = { queued: 0, rendering: 1, done: 2, failed: 3 }
const rowStatus = computed(() => {
  const map = new Map<string, BatchStatus>()
  for (const item of items.value) {
    const prev = map.get(item.rowId)
    if (!prev || STATUS_RANK[item.status] > STATUS_RANK[prev]) map.set(item.rowId, item.status)
  }
  return map
})
const rowError = computed(() => {
  const map = new Map<string, string>()
  for (const item of items.value) {
    if (item.status === 'failed' && item.error) map.set(item.rowId, item.error)
  }
  return map
})
const hasFailed = computed(() => items.value.some(i => i.status === 'failed'))

// --- Table / Results view toggle -----------------------------------------
const view = ref<'table' | 'results'>('table')
const hasResults = computed(() => items.value.length > 0 && !running.value)

// Auto-switch to Results the moment a full-batch run finishes; the user can
// always click back to Table manually afterwards. Only full-batch entry
// points (confirmGenerate / retryFailed) arm this flag — single-item
// retryItem runs must not yank the user out of Table mid-workflow.
const autoShowResults = ref(false)
watch(running, (isRunning, wasRunning) => {
  if (wasRunning && !isRunning && items.value.length && autoShowResults.value) view.value = 'results'
  if (wasRunning && !isRunning) autoShowResults.value = false
})

function selectItem(item: BatchItem) {
  if (item.status !== 'done' || !collection.value) return
  collection.value.previewRow = item.rowIndex
}

// Results view "Keep" — promotes a sweep row's values onto row 0, drops every
// sweep row (including the kept one — keepRow copies its values in first),
// then re-pushes the resolved preview so wired targets snap to the kept look.
function isSweepRow(item: BatchItem): boolean {
  return !!collection.value?.rows.find(r => r.id === item.rowId)?.sweep
}
function keepItem(item: BatchItem) {
  if (!collection.value || !node.value) return
  const row = collection.value.rows.find(r => r.id === item.rowId)
  if (!row) return
  const sweptRowIds = new Set(collection.value.rows.filter(r => r.sweep).map(r => r.id))
  keepRow(collection.value, row.id)
  // keepRow removed every `sweep: true` row (row 0 survives even if it was
  // the kept row) — drop any now-stale result items that pointed at them.
  items.value = items.value.filter(i => !sweptRowIds.has(i.rowId))
  pushVarPreview(node.value, targets.value, props.nodes)
}

async function retryItem(item: BatchItem) {
  item.status = 'queued'
  item.error = undefined
  items.value = [...items.value]
  await runItems([item])
}

const exporting = ref(false)
async function exportZip() {
  if (!collection.value || exporting.value) return
  const done = items.value.filter(i => i.status === 'done' && i.url)
  if (!done.length) return
  exporting.value = true
  try {
    const zip = new JSZip()
    // Precompute which label+outputId combinations are duplicated across rows
    // so we can disambiguate with rowIndex only when needed.
    const keyCounts = new Map<string, number>()
    for (const item of done) {
      const key = `${sanitize(rowLabel(collection.value!, item.rowIndex))}_${item.outputId}`
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
    }
    for (const item of done) {
      const label = sanitize(rowLabel(collection.value!, item.rowIndex))
      const baseKey = `${label}_${item.outputId}`
      const isDupe = (keyCounts.get(baseKey) ?? 0) > 1
      const fname = isDupe ? `${baseKey}_${item.rowIndex + 1}.png` : `${baseKey}.png`
      const blob = await fetch(item.url!).then(r => r.blob())
      zip.file(fname, blob)
    }
    const out = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(out)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitize(collection.value.name)}_batch.zip`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  } finally {
    exporting.value = false
  }
}

function openConfirm() {
  if (!collection.value || !target.value || !generateN.value) return
  confirmOpen.value = true
}

// Picks the right per-item render fn for `target`: Smart Layout renders via
// the template-grid backend (buildRenderItem); every other VARS target is a
// studio surface baked client-side via its registered StudioParamBaker
// (buildStudioRenderItem). Kept as a tiny seam so runRows/runItems never
// special-case the target kind themselves.
function renderItemFor(targetNode: any, runStamp: string) {
  if (!collection.value) throw new Error('no collection')
  return targetNode.data?.nodeType === 'SmartLayout'
    ? buildRenderItem(targetNode, collection.value, targetBindings(), runStamp)
    : buildStudioRenderItem(String(targetNode.id), collection.value, targetBindings(), runStamp, props.nodes)
}

// `runItems` always renders against the currently wired `target.value` — true
// for every entry point today (confirmGenerate/retryFailed/retryItem/the sweep
// auto-run all act on rows of THIS collection, and a collection only acts on
// its one wired target). `runRows` takes an explicit
// `targetNode` anyway (rather than silently trusting `target.value`) so a
// future multi-target collection can't quietly render against the wrong node.
async function runItems(toRun: BatchItem[]) {
  if (!collection.value || !target.value) return
  running.value = true
  const signal = { cancelled: false }
  runSignal.value = signal
  const runStamp = Date.now().toString(36)
  const renderItem = renderItemFor(target.value, runStamp)
  try {
    await runBatch(toRun, renderItem, {
      concurrency: 3,
      signal,
      onUpdate: () => { items.value = [...items.value] },
    })
  } finally {
    running.value = false
    runSignal.value = null
  }
}

// Core batch-planning entry point: plans BatchItems for exactly the given row
// subset (all rows for a normal Generate run, or just the freshly-swept rows
// for a sweep auto-run) against the given target + output list, then hands
// off to runItems. confirmGenerate/retryFailed/the sweep auto-run handler all
// funnel through this so status column/results/cancel all behave identically
// regardless of entry point.
async function runRows(rows: CollectionRow[], targetNode: any, outputList: { id: string }[]) {
  if (!collection.value || !targetNode || String(targetNode.id) !== String(target.value?.id)) return
  const planned = planBatch(rows, outputList)
  // `rows` may be a filtered subset (e.g. just the freshly-appended sweep
  // rows), so planBatch's positional rowIndex (0,1,2…) does NOT match the
  // row's real position in collection.rows — but every consumer (resolveBindings,
  // rowLabel, isSweepRow/keepItem by index, preview highlight) resolves
  // rowIndex against the FULL collection.rows. Remap to the absolute index
  // here so row identity stays correct regardless of what subset was planned.
  const fullRows = collection.value.rows
  for (const item of planned) {
    const abs = fullRows.findIndex(r => r.id === item.rowId)
    if (abs !== -1) item.rowIndex = abs
  }
  items.value = planned
  autoShowResults.value = true
  await runItems(planned)
}

async function confirmGenerate() {
  if (!collection.value || !target.value) return
  confirmOpen.value = false
  await runRows(collection.value.rows, target.value, outputs.value)
}

function cancelRun() {
  if (runSignal.value) runSignal.value.cancelled = true
}

async function retryFailed() {
  const failed = items.value.filter(i => i.status === 'failed')
  for (const item of failed) { item.status = 'queued'; item.error = undefined }
  items.value = [...items.value]
  autoShowResults.value = true
  await runItems(failed)
}

// --- Sweep auto-run (Slice 2a Task 8b) ------------------------------------
// A studio surface's Sweep popover appends rows then dispatches
// `sailor:openCollection` (opens this drawer) immediately followed by
// `sailor:runSweepRows`. VueNodeCanvas is the only listener guaranteed to
// already be mounted when runSweepRows fires, so it stashes the detail and
// passes it down as `pendingSweep`; this drawer consumes it once mounted
// (its own key-based remount means onMounted always sees a fresh instance)
// and immediately tells the parent to clear the stash so a later reopen of
// the same collection doesn't replay a stale sweep.
const sweepWarning = ref('')
async function consumePendingSweep() {
  const pending = props.pendingSweep
  if (!pending || !collection.value) return
  if (String(pending.collectionNodeId) !== String(props.nodeId)) return
  emit('sweep-consumed')

  const rows = collection.value.rows.filter(r => pending.rowIds.includes(r.id))
  if (!rows.length) return

  const targetNode = props.nodes.find((n: any) => String(n.id) === String(pending.targetNodeId))
  if (!targetNode) return

  // Studio targets must be mounted (registered baker) to bake anything —
  // mirrors buildStudioRenderItem's own guard, checked up front so a sweep
  // against a closed studio surfaces one clear warning instead of N
  // per-item failures.
  if (targetNode.data?.nodeType !== 'SmartLayout' && !getStudioParamBaker(String(targetNode.id))) {
    sweepWarning.value = 'Open the studio to generate its sweep.'
    return
  }
  // Sweep runs skip the confirm modal (no user to read the warning list
  // there) but must still respect validateRun — an invalid binding (e.g. a
  // non-hex color cell) should abort the same way it would block a normal
  // confirm-modal Generate, not silently render garbage.
  if (validateRun(collection.value, targetBindings()).length) {
    sweepWarning.value = 'Fix the row values flagged in the table before sweeping.'
    return
  }
  sweepWarning.value = ''

  const outputList = targetNode.data?.nodeType === 'SmartLayout' ? outputs.value : [{ id: 'output' }]
  await runRows(rows, targetNode, outputList)
}
onMounted(() => { consumePendingSweep() })
watch(() => props.pendingSweep, () => { consumePendingSweep() })

const pasteOpen = ref(false)
const pasteText = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

function onAddRow() { if (!running.value && collection.value) addRow(collection.value) }
function onAddColumn() { if (!running.value && collection.value) addColumn(collection.value, `Column ${collection.value.columns.length + 1}`, 'text') }
function onRemoveRow(rowId: string) {
  if (running.value || !collection.value) return
  removeRow(collection.value, rowId)
  clampPreviewRow(collection.value)
}
function onRemoveColumn(key: string) { if (!running.value && collection.value) removeColumn(collection.value, key) }
function onCell(rowId: string, key: string, e: Event) {
  if (!collection.value) return
  setCell(collection.value, rowId, key, (e.target as HTMLInputElement).value)
}
function selectRow(i: number) { if (collection.value) collection.value.previewRow = i }
function applyPaste() {
  if (running.value || !collection.value || !pasteText.value.trim()) return
  importTable(collection.value, pasteText.value)
  pasteOpen.value = false
  pasteText.value = ''
}
async function onFile(e: Event) {
  if (running.value) return
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f || !collection.value) return
  importTable(collection.value, await f.text())
  if (fileInput.value) fileInput.value.value = ''
}

// --- Image cell upload -----------------------------------------------------
// Click-to-upload / drag-drop on an image cell. `cellUploading`/`cellError`
// are keyed by `${rowId}:${colKey}` so multiple cells can be mid-upload (or
// showing a stale error) independently. Errors self-clear after 3s — no toast
// machinery exists in this drawer, so a transient red ring + title is the
// established inline-error convention here.
const cellFileInputs = ref<Record<string, HTMLInputElement | null>>({})
const cellUploading = ref<Set<string>>(new Set())
const cellError = ref<Record<string, string>>({})

function cellKey(rowId: string, colKey: string): string {
  return `${rowId}:${colKey}`
}
function setCellFileInput(key: string, el: any) {
  cellFileInputs.value[key] = (el as HTMLInputElement) ?? null
}
function openCellUpload(rowId: string, colKey: string) {
  if (running.value) return
  cellFileInputs.value[cellKey(rowId, colKey)]?.click()
}
async function uploadToCell(rowId: string, colKey: string, file: File | undefined) {
  if (!file || !collection.value || running.value) return
  const key = cellKey(rowId, colKey)
  delete cellError.value[key]
  cellUploading.value.add(key)
  cellUploading.value = new Set(cellUploading.value)
  try {
    const url = await uploadMediaFile(file)
    setCell(collection.value, rowId, colKey, url)
  } catch {
    cellError.value = { ...cellError.value, [key]: 'Upload failed' }
    setTimeout(() => {
      const next = { ...cellError.value }
      delete next[key]
      cellError.value = next
    }, 3000)
  } finally {
    cellUploading.value.delete(key)
    cellUploading.value = new Set(cellUploading.value)
  }
}
function onCellFileChange(rowId: string, colKey: string, e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  uploadToCell(rowId, colKey, file)
  input.value = ''
}
function onCellDrop(rowId: string, colKey: string, e: DragEvent) {
  if (running.value) return
  const file = e.dataTransfer?.files?.[0]
  uploadToCell(rowId, colKey, file)
}

// --- Column header bulk upload ---------------------------------------------
// Multi-select file input beside an image column's type dropdown: uploads
// each file sequentially, then appends ONE row per successful upload via
// `addMediaRows` (mirrors the sweep-row append pattern, but not sweep-marked
// since these are real user rows). Partial failures are counted and surfaced
// via the same inline `sweepWarning`-style message strip.
const headerFileInputs = ref<Record<string, HTMLInputElement | null>>({})
const columnUploading = ref<Set<string>>(new Set())
function setHeaderFileInput(key: string, el: any) {
  headerFileInputs.value[key] = (el as HTMLInputElement) ?? null
}
function openHeaderUpload(colKey: string) {
  if (running.value) return
  headerFileInputs.value[colKey]?.click()
}
async function onHeaderFilesChange(colKey: string, e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length || !collection.value || running.value) return

  columnUploading.value.add(colKey)
  columnUploading.value = new Set(columnUploading.value)
  const urls: string[] = []
  let failed = 0
  let skipped = 0
  try {
    for (const file of files) {
      // Guard against batch run starting mid-upload; break early and count remaining as skipped
      if (running.value) {
        skipped = files.length - urls.length - failed
        break
      }
      try {
        urls.push(await uploadMediaFile(file))
      } catch {
        failed++
      }
    }
    // Prevent adding rows if a batch started running during the upload loop
    if (running.value) {
      sweepWarning.value = 'Batch running — uploaded images were not added as rows.'
      return
    }
    if (urls.length) addMediaRows(collection.value, colKey, urls)
    sweepWarning.value = failed
      ? `${failed} of ${files.length} uploads failed`
      : ''
  } finally {
    columnUploading.value.delete(colKey)
    columnUploading.value = new Set(columnUploading.value)
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="collection"
      class="fixed left-0 right-0 bottom-0 z-[9000] h-[320px] bg-[#141414] border-t border-[#2a2a2a] flex flex-col text-white/90"
    >
      <div class="flex items-center gap-2 px-4 h-10 border-b border-white/10 shrink-0">
        <input
          v-model="collection.name"
          class="bg-transparent text-[12px] font-medium outline-none w-40 border-b border-transparent focus:border-white/20"
        />
        <span class="text-[11px] text-white/40">
          {{ collection.rows.length }} rows · {{ collection.columns.length }} columns
        </span>

        <div v-if="hasResults" class="flex items-center gap-0.5 rounded-md bg-white/5 border border-white/10 p-0.5 ml-2">
          <button
            class="px-2 h-5 rounded text-[11px] leading-5 transition"
            :class="view === 'table' ? 'bg-white/15 text-white/90' : 'text-white/50 hover:text-white/70'"
            @click="view = 'table'"
          >
            Table
          </button>
          <button
            class="px-2 h-5 rounded text-[11px] leading-5 transition"
            :class="view === 'results' ? 'bg-white/15 text-white/90' : 'text-white/50 hover:text-white/70'"
            @click="view = 'results'"
          >
            Results
          </button>
        </div>

        <div class="flex-1" />
        <button v-if="view === 'results'" class="drawer-btn" :disabled="exporting" :class="{ 'opacity-40 cursor-not-allowed': exporting }" @click="exportZip">
          <Upload class="size-3.5" /> Export zip
        </button>
        <template v-if="view === 'table'">
          <button class="drawer-btn" :disabled="running" :class="{ 'opacity-40 cursor-not-allowed': running }" @click="pasteOpen = !pasteOpen">
            <ClipboardPaste class="size-3.5" /> Paste data
          </button>
          <button class="drawer-btn" :disabled="running" :class="{ 'opacity-40 cursor-not-allowed': running }" @click="fileInput?.click()">
            <Upload class="size-3.5" /> Import CSV
          </button>
          <input ref="fileInput" type="file" accept=".csv,.tsv,.txt" class="hidden" @change="onFile" />
          <button class="drawer-btn" :disabled="running" :class="{ 'opacity-40 cursor-not-allowed': running }" @click="onAddColumn"><Plus class="size-3.5" /> Column</button>
        </template>
        <button class="p-1.5 rounded hover:bg-white/10" @click="emit('close')"><X class="size-4" /></button>
      </div>

      <div v-if="pasteOpen && view === 'table'" class="px-4 py-2 border-b border-white/10 shrink-0">
        <textarea
          v-model="pasteText"
          rows="4"
          placeholder="Paste CSV or spreadsheet cells — first row is headers"
          class="w-full bg-white/5 border border-white/10 rounded-md p-2 text-[12px] outline-none focus:border-white/25"
        />
        <div class="flex justify-end gap-2 mt-1">
          <button class="drawer-btn" @click="pasteOpen = false">Cancel</button>
          <button class="drawer-btn !bg-white/15" @click="applyPaste">Replace table</button>
        </div>
      </div>

      <div v-if="sweepWarning" class="px-4 py-1.5 border-b border-amber-400/20 bg-amber-500/10 text-[11px] text-amber-300/90 shrink-0">
        {{ sweepWarning }}
      </div>

      <div v-if="view === 'results'" class="flex-1 overflow-auto p-3">
        <div class="grid grid-cols-6 gap-2">
          <div
            v-for="item in items"
            :key="item.id"
            class="rounded-md border overflow-hidden"
            :class="item.status === 'failed' ? 'border-red-400/30 bg-red-500/10' : 'border-white/10 bg-white/5'"
          >
            <button
              v-if="item.status === 'done' && item.url"
              class="block w-full aspect-square cursor-pointer group relative"
              :class="{ 'ring-2 ring-white/40': item.rowIndex === collection.previewRow }"
              @click="selectItem(item)"
            >
              <img :src="item.url" class="w-full h-full object-cover" />
              <span
                v-if="isSweepRow(item)"
                class="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white/80 opacity-0 transition group-hover:opacity-100 hover:!bg-action/80 hover:text-white"
                @click.stop="keepItem(item)"
              >
                <Check class="size-3" /> Keep
              </span>
            </button>
            <div
              v-else-if="item.status === 'failed'"
              class="w-full aspect-square flex flex-col items-center justify-center gap-1.5 p-2 text-center"
            >
              <span class="text-[10px] text-red-300/90 line-clamp-3">{{ item.error || 'Failed' }}</span>
              <button class="drawer-btn !h-5 !px-1.5 !text-[10px]" @click="retryItem(item)">Retry</button>
            </div>
            <div v-else class="w-full aspect-square flex items-center justify-center">
              <span
                class="inline-block size-2 rounded-full"
                :class="item.status === 'rendering' ? 'bg-white/60 animate-pulse' : 'bg-white/20'"
              />
            </div>
            <div class="px-1.5 py-1 text-[10px] text-white/50 truncate">
              {{ rowLabel(collection, item.rowIndex) }} · {{ item.outputId }}
            </div>
          </div>
        </div>
      </div>

      <div v-if="view === 'table'" class="flex-1 overflow-auto">
        <table class="w-full text-[12px] border-collapse">
          <thead>
            <tr class="text-white/40 sticky top-0 bg-[#141414]">
              <th class="w-9 border-b border-white/10" />
              <th v-if="items.length" class="w-6 border-b border-white/10" />
              <th v-for="col in collection.columns" :key="col.key" class="text-left font-normal px-2 py-1.5 border-b border-white/10 min-w-[140px]">
                <div class="flex items-center gap-1.5">
                  <input v-model="col.label" class="bg-transparent outline-none w-24 text-white/70" />
                  <select v-model="col.type" class="bg-[#141414] text-white/40 text-[11px] outline-none">
                    <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
                  </select>
                  <button
                    v-if="col.type === 'image'"
                    class="opacity-40 hover:opacity-100 disabled:opacity-20 disabled:cursor-not-allowed"
                    :disabled="running"
                    title="Upload images"
                    @click="openHeaderUpload(col.key)"
                  >
                    <Loader2 v-if="columnUploading.has(col.key)" class="size-3 animate-spin" />
                    <ImagePlus v-else class="size-3" />
                  </button>
                  <input
                    v-if="col.type === 'image'"
                    :ref="(el) => setHeaderFileInput(col.key, el)"
                    type="file"
                    :accept="IMAGE_ACCEPT"
                    multiple
                    class="hidden"
                    @change="onHeaderFilesChange(col.key, $event)"
                  />
                  <button class="opacity-40 hover:opacity-100" @click="onRemoveColumn(col.key)">
                    <Trash2 class="size-3" />
                  </button>
                </div>
              </th>
              <th
                v-for="col in linkedCols"
                :key="col.key"
                class="text-left font-normal px-2 py-1.5 border-b border-white/10 min-w-[140px]"
                style="background: rgba(244,114,182,0.06)"
                title="Linked from another collection — read-only"
              >
                <div class="flex items-center gap-1.5 text-pink-300/80">
                  <Link2 class="size-3 shrink-0" />
                  <span class="truncate">{{ col.label }}</span>
                  <button class="opacity-40 hover:opacity-100 ml-auto" title="Edit in table" @click="openForeign(col.sourceCollectionId)">
                    <Link2 class="size-3" />
                  </button>
                </div>
              </th>
              <th class="border-b border-white/10 w-full" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, i) in collection.rows"
              :key="row.id"
              class="cursor-pointer group"
              :class="i === collection.previewRow ? 'bg-white/10' : 'hover:bg-white/5'"
              @click="selectRow(i)"
            >
              <td class="px-2 py-1 text-white/30 tabular-nums border-b border-white/5 text-right">{{ i + 1 }}</td>
              <td v-if="items.length" class="px-1 py-1 border-b border-white/5 text-center">
                <span
                  class="inline-block size-2 rounded-full"
                  :class="{
                    'bg-white/20': rowStatus.get(row.id) === 'queued',
                    'bg-white/60 animate-pulse': rowStatus.get(row.id) === 'rendering',
                    'bg-emerald-400': rowStatus.get(row.id) === 'done',
                    'bg-red-400': rowStatus.get(row.id) === 'failed',
                  }"
                  :title="rowError.get(row.id) ?? ''"
                />
              </td>
              <td v-for="col in collection.columns" :key="col.key" class="px-2 py-1 border-b border-white/5">
                <div class="flex items-center gap-1.5">
                  <template v-if="col.type === 'color'">
                    <input
                      type="color"
                      :value="/^#([0-9a-f]{6})$/i.test(String(row.values[col.key] ?? '')) ? String(row.values[col.key]) : '#000000'"
                      class="size-4 rounded border-0 bg-transparent p-0 cursor-pointer"
                      @input="onCell(row.id, col.key, $event)"
                      @click.stop
                    />
                  </template>
                  <template v-else-if="col.type === 'image'">
                    <div
                      class="relative size-5 rounded border flex items-center justify-center shrink-0 cursor-pointer transition"
                      :class="cellError[cellKey(row.id, col.key)]
                        ? 'border-red-400/60 ring-1 ring-red-400/60'
                        : 'border-white/10 border-dashed hover:border-white/30'"
                      :title="cellError[cellKey(row.id, col.key)] || 'Upload image'"
                      @click.stop="openCellUpload(row.id, col.key)"
                      @dragover.prevent
                      @drop.stop.prevent="onCellDrop(row.id, col.key, $event)"
                    >
                      <img
                        v-if="isImageUrl(row.values[col.key])"
                        :src="String(row.values[col.key])"
                        class="size-5 rounded object-cover"
                        :class="{ 'opacity-40': cellUploading.has(cellKey(row.id, col.key)) }"
                      />
                      <ImagePlus v-else class="size-3 text-white/30" />
                      <Loader2
                        v-if="cellUploading.has(cellKey(row.id, col.key))"
                        class="size-3 animate-spin text-white/80 absolute inset-0 m-auto"
                      />
                      <input
                        :ref="(el) => setCellFileInput(cellKey(row.id, col.key), el)"
                        type="file"
                        :accept="IMAGE_ACCEPT"
                        class="hidden"
                        @click.stop
                        @change="onCellFileChange(row.id, col.key, $event)"
                      />
                    </div>
                  </template>
                  <input
                    :value="row.values[col.key] ?? ''"
                    class="bg-transparent outline-none flex-1 min-w-[60px] focus:bg-white/5 rounded px-1"
                    @input="onCell(row.id, col.key, $event)"
                    @click.stop
                  />
                </div>
              </td>
              <td
                v-for="(col, ci) in linkedCols"
                :key="col.key"
                class="px-2 py-1 border-b border-white/5 text-white/40"
                style="background: rgba(244,114,182,0.06)"
              >
                {{ linkedCellText(i, ci) }}
              </td>
              <td class="border-b border-white/5 pr-2 text-right">
                <button class="opacity-0 group-hover:opacity-40 hover:!opacity-100" :class="{ 'opacity-0 cursor-not-allowed': running }" :disabled="running" @click.stop="onRemoveRow(row.id)">
                  <Trash2 class="size-3" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <button class="drawer-btn m-2" :disabled="running" :class="{ 'opacity-40 cursor-not-allowed': running }" @click="onAddRow"><Plus class="size-3.5" /> Row</button>
      </div>

      <div class="relative flex items-center gap-3 px-4 h-9 border-t border-white/10 shrink-0 text-[11px] text-white/40">
        <span>Click a row to preview it on canvas</span>
        <div class="flex-1" />

        <span v-if="running" class="text-white/50">Generating…</span>
        <button v-if="running" class="drawer-btn" @click="cancelRun">Cancel</button>
        <button v-if="!running && hasFailed" class="drawer-btn" @click="retryFailed">Retry failed</button>

        <button
          v-if="!running"
          class="flex items-center gap-1.5 px-3 h-7 rounded text-[11px] font-medium bg-action/15 text-action transition hover:bg-action/25 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!generateN"
          @click="openConfirm"
        >
          <Play class="size-3.5" /> Generate {{ generateN }}
        </button>

        <div
          v-if="confirmOpen"
          class="absolute bottom-10 right-4 w-72 rounded-lg border border-white/10 bg-[#1a1a1a] shadow-xl p-3 text-white/80 z-10"
        >
          <div class="text-[12px] font-medium text-white/90">{{ estimate.label }}</div>
          <div v-if="warnings.length" class="mt-2 space-y-1 max-h-32 overflow-auto">
            <div v-for="(w, wi) in warningsShown" :key="wi" class="text-[11px] text-amber-300/80">
              Row {{ w.rowIndex + 1 }}: {{ w.message }}
            </div>
            <div v-if="warningsMore" class="text-[11px] text-white/40">…and {{ warningsMore }} more</div>
          </div>
          <div class="flex justify-end gap-2 mt-3">
            <button class="drawer-btn" @click="confirmOpen = false">Cancel</button>
            <button
              class="flex items-center gap-1.5 px-3 h-7 rounded text-[11px] font-medium bg-action/15 text-action transition hover:bg-action/25"
              @click="confirmGenerate"
            >
              <Play class="size-3.5" /> Generate
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.drawer-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0 0.625rem;
  height: 1.75rem;
  border-radius: 0.375rem;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.8);
}
.drawer-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}
</style>
