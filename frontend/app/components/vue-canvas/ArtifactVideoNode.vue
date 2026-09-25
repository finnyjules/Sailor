<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import { Upload, Loader2, Film, Play, RefreshCw, Download } from 'lucide-vue-next'
import { getTypeColor } from '~/composables/useVueNodes'
import NodeRunRow from '~/components/vue-canvas/NodeRunRow.vue'
import { runRowStatus } from '~/lib/canvas/runRowStatus'
import { useRunRowClock } from '~/composables/useRunRowClock'

// Visual half of the unified `Video` artifact node. Same state machine as
// the Image / Audio cards. Result lands in `data.images` (PreviewVideo's
// UI envelope reuses the images key with animated=true), so we treat
// `data.images[0]` as the video URL.
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
    animated?: boolean
    outputNode?: boolean
  }
}>()

const isMuted = computed(() => props.data.mode === 2)
const isBypassed = computed(() => props.data.mode === 4)
const videoColor = computed(() => getTypeColor('VIDEO'))

const injectedEdges = inject<any>('vueFlowEdges', null)

function inputIdx(name: string): number {
  return props.data.inputs?.findIndex(i => i.name === name) ?? -1
}
function outputIdx(name: string): number {
  return props.data.outputs?.findIndex(o => o.name === name) ?? -1
}
function widgetIdx(name: string): number {
  return props.data.widgetDefs?.findIndex((w: any) => w.name === name) ?? -1
}

const sourceInputIdx = computed(() => inputIdx('source'))
const videoOutputIdx = computed(() => outputIdx('video'))
const fileWidgetIdx = computed(() => widgetIdx('file'))

const widgetFilename = computed<string>(() => {
  const i = fileWidgetIdx.value
  return i >= 0 ? (props.data.widgetsValues?.[i] || '') : ''
})

const hasUpstream = computed(() => {
  const idx = sourceInputIdx.value
  if (idx < 0) return false
  if (props.data.inputs?.[idx]?.link != null) return true
  const edges = injectedEdges?.value ?? []
  return edges.some((e: any) => e.target === props.id && e.targetHandle === `input-${idx}`)
})

const videoUrl = computed<string | null>(() => {
  if (props.data.images?.length) return props.data.images[0]!
  if (!hasUpstream.value && widgetFilename.value) {
    return `/view?${new URLSearchParams({ filename: widgetFilename.value, type: 'input' })}`
  }
  return null
})

// Format seconds as M:SS (or H:MM:SS past an hour). Null for unknown/streamed
// durations (some sources report Infinity until fully buffered).
function fmtDuration(s: number): string | null {
  if (!isFinite(s) || s <= 0) return null
  const t = Math.round(s)
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return (h > 0 ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`
}

// Footer label: dimensions · duration, read from the <video> metadata on load.
// Reset when the source changes so stale values don't linger.
const meta = ref<string | null>(null)
watch(videoUrl, () => { meta.value = null })
function onVideoMeta(e: Event) {
  const v = e.target as HTMLVideoElement
  const dims = v.videoWidth ? `${v.videoWidth} × ${v.videoHeight}` : null
  meta.value = [dims, fmtDuration(v.duration)].filter(Boolean).join(' · ') || null
}

const filenameLabel = computed<string | null>(() => {
  if (widgetFilename.value) return widgetFilename.value
  const url = videoUrl.value
  if (!url) return null
  const m = url.match(/[?&]filename=([^&]+)/)
  if (m && m[1]) {
    try { return decodeURIComponent(m[1]) } catch { return m[1] }
  }
  return null
})

const showUpload = computed(() => !videoUrl.value && !hasUpstream.value)
const showRender = computed(() => !videoUrl.value && hasUpstream.value)

const fileInputRef = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const hovered = ref(false)

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
    const idx = fileWidgetIdx.value
    if (idx >= 0 && props.data.widgetsValues) {
      props.data.widgetsValues[idx] = name
    }
    const def = props.data.widgetDefs?.find((d: any) => d.name === 'file')
    if (def && Array.isArray(def.options) && !def.options.includes(name)) {
      def.options.push(name)
    }
  } catch (err) {
    console.error('[ArtifactVideo] upload failed:', err)
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

// Drop accepts a file whenever the asset is local (empty or already loaded) —
// upstream-fed nodes get their media from the wire, so a dropped file wouldn't show.
const canReplace = computed(() => !hasUpstream.value)
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
function triggerUpload() { fileInputRef.value?.click() }

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

async function downloadVideo() {
  const url = videoUrl.value
  if (!url) return
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const obj = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = obj
    a.download = filenameLabel.value || 'video.mp4'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(obj)
  } catch (err) {
    console.error('[ArtifactVideo] download failed:', err)
  }
}
</script>

<template>
  <div
    class="artifact-video relative w-[280px] select-none"
    :class="{
      'artifact-video--muted': isMuted,
      'artifact-video--bypassed': isBypassed,
    }"
    :data-running="data.running || undefined"
    :style="{ '--port-color': videoColor } as any"
    @dragover="onDragOver"
    @drop="onDrop"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <VueCanvasNodeReadyBadge :node-id="id" />
    <Handle
      v-if="sourceInputIdx >= 0"
      :id="`input-${sourceInputIdx}`"
      type="target"
      :position="Position.Left"
      class="!w-3 !h-3 !rounded-full !border-2 !bg-[#1a1a1a]"
      :style="{ borderColor: videoColor, top: '50%' }"
    />
    <Handle
      v-if="videoOutputIdx >= 0"
      :id="`output-${videoOutputIdx}`"
      type="source"
      :position="Position.Right"
      class="!w-3 !h-3 !rounded-full !border-2 !bg-[#1a1a1a]"
      :style="{ borderColor: videoColor, top: '50%' }"
    />

    <div
      class="artifact-frame relative rounded-lg overflow-hidden bg-black/40 border border-white/10"
      :class="{ 'ring-2 ring-red-500': data.error }"
    >
      <!-- File picker — always mounted so Replace works in any state. -->
      <input
        ref="fileInputRef"
        type="file"
        accept="video/*"
        class="hidden"
        @change="onFileChange"
      />
      <template v-if="videoUrl">
        <!-- Chrome toolbar, overlaid on the top of the video and revealed
             on hover — same idiom as ArtifactImageNode so the two artifact
             cards read identically. -->
        <div
          class="nopan nodrag absolute inset-x-0 top-0 z-30 flex items-center gap-1.5 px-2 py-1.5 bg-gradient-to-b from-black/70 to-transparent transition-opacity duration-150"
          :class="hovered ? 'opacity-100' : 'opacity-0 pointer-events-none'"
        >
          <span class="truncate flex-1 text-[10px] tabular-nums text-white/80 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
            {{ meta || (hasUpstream ? 'Video (upstream)' : 'Video') }}
          </span>
          <button
            v-if="canReplace"
            class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center text-white/45 hover:text-white/85 hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-50"
            :disabled="uploading"
            title="Replace video"
            @click.stop="triggerUpload"
          >
            <Loader2 v-if="uploading" class="size-3 animate-spin" />
            <Upload v-else class="size-2.5" />
          </button>
          <button
            class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center text-white/45 hover:text-white/85 hover:bg-white/[0.08] transition-colors cursor-pointer"
            title="Download"
            @click.stop="downloadVideo"
          >
            <Download class="size-2.5" />
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
        </div>
        <video
          :src="videoUrl"
          class="block w-full max-h-[280px] object-contain bg-black"
          controls
          preload="metadata"
          playsinline
          @loadedmetadata="onVideoMeta"
        />
        <!-- Run row — where the Edit…/Develop… footer was. -->
        <NodeRunRow
          v-if="videoUrl && hasUpstream"
          :status="runStatus"
          :can-run="!isMuted && !isBypassed"
          :running="!!data.running"
          run-label="Re-render this node"
          @run="runThisNode"
        />
      </template>

      <template v-else-if="showUpload">
        <!-- Upload affordance — no nopan/nodrag so click-in-place opens
             the file picker but click-and-drag moves the card. -->
        <button
          class="w-full aspect-video flex flex-col items-center justify-center gap-2 text-white/45 hover:text-white/85 hover:bg-white/[0.04] transition-colors cursor-pointer disabled:opacity-50"
          :disabled="uploading"
          @click="triggerUpload"
        >
          <Loader2 v-if="uploading" class="size-7 animate-spin" />
          <Film v-else class="size-7" :stroke-width="1.5" />
          <span class="text-[11px]">{{ uploading ? 'Uploading…' : 'Drop or click a video' }}</span>
        </button>
      </template>

      <template v-else>
        <div class="aspect-video flex flex-col items-center justify-center gap-2 text-white/35 px-4">
          <Film class="size-7" :stroke-width="1.5" />
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
    </div>
  </div>
</template>

<style scoped>
.artifact-video[data-running] .artifact-frame {
  box-shadow:
    0 0 0 2px var(--port-color, #fff),
    0 4px 16px rgba(0, 0, 0, 0.4);
}
.artifact-frame {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 1px 4px rgba(0, 0, 0, 0.2);
}
.artifact-video--muted { opacity: 0.45; filter: grayscale(0.8); }
.artifact-video--bypassed { opacity: 0.85; }
.artifact-video--bypassed .artifact-frame {
  border-style: dashed;
  border-color: rgba(251, 191, 36, 0.35);
}
</style>
