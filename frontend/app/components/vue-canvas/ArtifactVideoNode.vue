<script setup lang="ts">
import { Loader2, Film, Play, Download } from 'lucide-vue-next'
import { getTypeColor } from '~/composables/useVueNodes'
import NodeRunRow from '~/components/vue-canvas/NodeRunRow.vue'
import ContentCard from '~/components/vue-canvas/surfaces/ContentCard.vue'
import NodeMoreMenu, { type MoreItem } from '~/components/vue-canvas/surfaces/NodeMoreMenu.vue'
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

// The old hover strip's Replace/Re-render buttons, now the More menu — same
// functions, same guards as the removed buttons.
const moreItems = computed<MoreItem[]>(() => [
  ...(canReplace.value ? [{ label: 'Replace video', onSelect: triggerUpload, disabled: uploading.value }] : []),
  { label: props.data.running ? 'Running…' : 'Re-render', onSelect: runThisNode, disabled: !!props.data.running || isMuted.value || isBypassed.value },
])
</script>

<template>
  <div class="relative w-fit">
    <VueCanvasNodePort
      v-if="sourceInputIdx >= 0"
      :id="`input-${sourceInputIdx}`"
      type="target"
      side="left"
      :data-type="data.inputs?.[sourceInputIdx]?.type ?? 'VIDEO'"
      label="Video"
      :index="0"
    />
    <VueCanvasNodePort
      v-if="videoOutputIdx >= 0"
      :id="`output-${videoOutputIdx}`"
      type="source"
      side="right"
      :data-type="data.outputs?.[videoOutputIdx]?.type ?? 'VIDEO'"
      label="Video"
      :index="0"
    />

    <ContentCard
      class="artifact-video relative z-10 w-[280px] select-none"
      :class="{
        'artifact-video--muted': isMuted,
        'artifact-video--bypassed': isBypassed,
      }"
      :name="filenameLabel || 'Video'"
      :selected="selected"
      :data-running="data.running || undefined"
      :data-error="data.error || undefined"
      :style="{ '--port-color': videoColor } as any"
      @dragover="onDragOver"
      @drop="onDrop"
    >
      <template #meta>
        <span v-if="meta" class="shrink-0 tabular-nums text-white/30">{{ meta }}</span>
      </template>

      <VueCanvasNodeReadyBadge :node-id="id" />
      <!-- File picker — always mounted so Replace works in any state. -->
      <input
        ref="fileInputRef"
        type="file"
        accept="video/*"
        class="hidden"
        @change="onFileChange"
      />
      <template v-if="videoUrl">
        <video
          :src="videoUrl"
          class="block w-full max-h-[280px] object-contain bg-black"
          controls
          preload="metadata"
          playsinline
          @loadedmetadata="onVideoMeta"
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

      <template #actions>
        <button v-if="videoUrl" type="button" title="Download" @click.stop="downloadVideo">
          <Download class="size-3.5" />
        </button>
        <NodeMoreMenu :items="moreItems" />
      </template>

      <template #below>
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
    </ContentCard>
  </div>
</template>

<style scoped>
.artifact-video--muted { opacity: 0.45; filter: grayscale(0.8); }
.artifact-video--bypassed { opacity: 0.85; }
.artifact-video--bypassed :deep(.content-card__media) {
  outline: 1px dashed rgba(251, 191, 36, 0.35);
  outline-offset: -1px;
}
</style>
