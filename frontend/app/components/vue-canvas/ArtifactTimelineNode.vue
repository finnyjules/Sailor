<script setup lang="ts">
import { Loader2 } from 'lucide-vue-next'
import { getTypeColor } from '~/composables/useVueNodes'
import { useNodePortSync } from '~/composables/useNodePortSync'
import { migrateEditState } from '~~/shared/timeline/types'
import PrintSurface from '~/components/vue-canvas/surfaces/PrintSurface.vue'
import NodeOpenBar from '~/components/vue-canvas/surfaces/NodeOpenBar.vue'

// This card grows when clips connect, which moves its handles. Vue Flow caches
// handle geometry at mount, so without this refresh its edges stay pinned to
// where the ports were before the growth.
const portSyncRoot = ref<HTMLElement | null>(null)
useNodePortSync(portSyncRoot)

// The "Timeline" as a first-class artifact card — same visual language as the
// Frame / Image / Video artifacts. Edge-mounted round handles, a tight dark
// shell, and a live animated preview as the main content. The full multi-track
// editor still opens in its modal ("Open"); this card is the on-canvas
// face of it. Mirrors ArtifactFrameNode's chrome + resize.
const props = defineProps<{
  id: string
  data: {
    nodeType: string
    title: string
    inputs: { name: string; type: string; link: number | null }[]
    outputs: { name: string; type: string; links: number[] | null }[]
    widgetsValues: any[]
    widgetDefs?: any[]
    properties?: Record<string, any>
    mode: number
    running?: boolean
    error?: boolean
  }
  selected?: boolean
}>()

const printRef = ref<{ capture: (src: HTMLCanvasElement) => void } | null>(null)

const MAX_CLIPS = 16
const isMuted = computed(() => props.data.mode === 2)
const isBypassed = computed(() => props.data.mode === 4)
const imageColor = computed(() => getTypeColor('IMAGE'))
const injectedEdges = inject<any>('vueFlowEdges', null)

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }
function outputIdx(name: string): number {
  const i = props.data.outputs?.findIndex(o => o.name === name) ?? -1
  return i >= 0 ? i : 0
}
function widgetIdx(name: string): number { return props.data.widgetDefs?.findIndex((w: any) => w.name === name) ?? -1 }
function widgetVal(name: string): number { const i = widgetIdx(name); return i >= 0 ? Number(props.data.widgetsValues?.[i] ?? 0) : 0 }
const framesOutIdx = computed(() => outputIdx('frames'))
// No 0-fallback here (unlike outputIdx): -1 means "no video output" — stale
// saved data that skipped the schema sync — and the handle simply doesn't render.
const videoOutIdx = computed(() => props.data.outputs?.findIndex(o => o.name === 'video') ?? -1)

// ── Clip input handles (grow-on-connect, mirrors the Frame's layerSlots) ─────
function slotConnected(slotIdx: number): boolean {
  if (props.data.inputs?.[slotIdx]?.link != null) return true
  const edges = injectedEdges?.value ?? []
  return edges.some((e: any) => e.target === props.id && e.targetHandle === `input-${slotIdx}`)
}
const clipSlots = computed<number[]>(() => {
  const connected: number[] = []
  for (let i = 0; i < MAX_CLIPS; i++) if (slotConnected(i)) connected.push(i)
  const next = connected.length ? Math.max(...connected) + 1 : 0
  const slots = [...connected]
  if (next < MAX_CLIPS) slots.push(next)
  return slots
})

// ── Header summary (prefer the editor's edit_state; fall back to widgets) ─────
const editState = computed<any>(() => {
  const raw = props.data.properties?.edit_state
  if (!raw) return null
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
})
const summary = computed<string>(() => {
  const raw = editState.value
  const es = raw ? migrateEditState(raw) : null
  if (es) {
    const fps = es.canvas?.fps || 30
    const frames = es.total_frames || 0
    const clips = (es.tracks ?? []).reduce((n: number, t: any) => n + (t.clips?.length ?? 0), 0)
    if (frames > 0) return `${(frames / fps).toFixed(1)}s · ${clips} clip${clips === 1 ? '' : 's'}`
    return clips ? `${clips} clip${clips === 1 ? '' : 's'}` : ''
  }
  const fps = widgetVal('output_fps') || 30
  const dur = widgetVal('total_duration')
  return dur > 0 ? `${(dur / fps).toFixed(1)}s` : ''
})

// ── Resize (zoom-aware, width-based; persists on the node) ───────────────────
const DEFAULT_W = 320, MIN_W = 240, MAX_W = 920
const shellRef = ref<HTMLElement | null>(null)
const nodeW = computed<number>(() => {
  const v = Number(props.data.properties?.sailor_nodeW)
  return v >= MIN_W && v <= MAX_W ? v : DEFAULT_W
})
function setNodeW(v: number) {
  if (!props.data.properties) (props.data as any).properties = {}
  ;(props.data.properties as any).sailor_nodeW = Math.round(clamp(v, MIN_W, MAX_W))
}
let resize: { startW: number; sx: number; zoom: number } | null = null
function onResizeDown(e: PointerEvent) {
  e.preventDefault(); e.stopPropagation()
  const r = shellRef.value?.getBoundingClientRect()
  const zoom = r && nodeW.value ? r.width / (nodeW.value - 12) : 1
  resize = { startW: nodeW.value, sx: e.clientX, zoom: zoom || 1 }
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeUp, { once: true })
}
function onResizeMove(e: PointerEvent) {
  if (!resize) return
  setNodeW(resize.startW + (e.clientX - resize.sx) / resize.zoom)
}
function onResizeUp() { resize = null; window.removeEventListener('pointermove', onResizeMove) }
onUnmounted(() => window.removeEventListener('pointermove', onResizeMove))

// ── Actions ──────────────────────────────────────────────────────────────────
function openEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openTimeline', { detail: { nodeId: props.id } }))
}
function runThisNode() {
  if (isMuted.value || isBypassed.value || props.data.running) return
  window.dispatchEvent(new CustomEvent('sailor:runFiltered', { detail: { targetIds: [props.id], rerollScope: 'self' } }))
}
</script>

<template>
  <div
    ref="portSyncRoot"
    class="artifact-timeline relative select-none"
    :class="{ 'artifact-timeline--muted': isMuted, 'artifact-timeline--bypassed': isBypassed }"
    :style="{ width: nodeW + 'px', '--port-color': imageColor } as any"
  >
    <PrintSurface
      ref="printRef"
      name="Timeline"
      :size="summary || undefined"
      :selected="selected"
      :data-running="data.running || undefined"
      :data-error="data.error ? '' : undefined"
      :data-bypassed="isBypassed ? '' : undefined"
    >
      <div ref="shellRef">
        <VueCanvasTimelineNodePreview :node-id="id" @still="(c: HTMLCanvasElement) => printRef?.capture(c)" />
      </div>

      <template #openbar>
        <NodeOpenBar>
          <button type="button" class="node-btn nopan nodrag" title="Open the timeline editor" @click.stop="openEditor">Open</button>
          <button
            type="button" class="node-btn node-btn--primary nopan nodrag"
            :disabled="data.running || isMuted || isBypassed"
            :title="data.running ? 'Running…' : 'Render frames'"
            @click.stop="runThisNode"
          ><Loader2 v-if="data.running" class="size-3.5 animate-spin" />Render</button>
        </NodeOpenBar>
      </template>

      <template #ports>
        <VueCanvasNodePort
          v-for="(slot, i) in clipSlots" :id="`input-${slot}`" :key="slot"
          type="target" side="left" :index="i" data-type="IMAGE" label="clip"
        />
        <VueCanvasNodePort
          :id="`output-${framesOutIdx}`" type="source" side="right"
          :index="0" data-type="IMAGE" label="frames"
        />
        <VueCanvasNodePort
          v-if="videoOutIdx >= 0"
          :id="`output-${videoOutIdx}`" type="source" side="right"
          :index="1" data-type="VIDEO" label="video"
        />
      </template>

      <template #overlay>
        <VueCanvasNodeReadyBadge :node-id="id" />
        <!-- Mode badge -->
        <div
          v-if="isMuted || isBypassed"
          class="pointer-events-none absolute top-1.5 right-1.5 z-[6] text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
          :class="isBypassed ? 'bg-amber-500/25 text-amber-200 border border-amber-400/30' : 'bg-white/15 text-white/70 border border-white/15'"
        >{{ isBypassed ? 'Bypass' : 'Mute' }}</div>
        <!-- Corner resize grip — on-canvas display size -->
        <div
          class="nopan nodrag absolute -bottom-1.5 -right-1.5 size-4 cursor-nwse-resize group/resize z-[7]"
          title="Resize timeline card"
          @pointerdown="onResizeDown"
        >
          <div class="absolute bottom-1 right-1 size-2 border-b-2 border-r-2 border-white/30 group-hover/resize:border-white/70 rounded-[1px]" />
        </div>
      </template>
    </PrintSurface>
  </div>
</template>

<style scoped>
.artifact-timeline--muted { opacity: 0.45; filter: grayscale(0.8); }
.artifact-timeline--bypassed { opacity: 0.85; }
</style>
