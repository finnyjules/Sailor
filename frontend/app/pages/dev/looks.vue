<script setup lang="ts">
/** Looks gallery — the v7 spike's own looks, captured as real, editable Frames.
 *
 *  Each look in SPIKE_LOOKS (frontend/app/lib/frame/looksSpike.ts) was extracted
 *  from the spike prototype and expressed as Frame layers. Pick one and it loads
 *  into a single portrait Frame; hit Adjust to open the Compositor and tune it —
 *  drag the type, recolour, change a word. The intent: Julien hand-tunes these
 *  into the canonical default looks. Reachable only at /dev/looks. Hard-reload
 *  after editing. Not a saved project yet. */
import { VueFlow } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import CompositorModal from '~/components/vue-canvas/CompositorModal.vue'
import ArtifactFrameNode from '~/components/vue-canvas/ArtifactFrameNode.vue'
import { SPIKE_LOOKS } from '~/lib/frame/looksSpike'

definePageMeta({ layout: false })

// The spike's faces (the default is Inter Tight; the others are here so a
// re-authored look can reach for them without another font round-trip).
useHead({
  link: [{
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@100..900&family=Archivo:wght@100..900&family=Anton&family=Bricolage+Grotesque:wght@200..800&family=Syne:wght@400..800&family=Unbounded:wght@200..900&family=Instrument+Serif&display=swap',
  }],
})

const LOOKS = SPIKE_LOOKS
// The spike tile is 264×373; match its aspect so the captured geometry lands true.
const FW = 900, FH = Math.round(900 * 373 / 264)

const node = reactive({
  id: 'n1',
  data: {
    nodeType: 'CompositorNode',
    title: 'Frame',
    inputs: [], outputs: [{ name: 'image', type: 'IMAGE', links: null }],
    widgetsValues: [FW, FH] as any[], widgetDefs: [{ name: 'width' }, { name: 'height' }],
    images: [] as string[],
    properties: {
      sailor_localLayers: LOOKS[0].layers(),
      sailor_localGroups: [],
      sailor_localBg: LOOKS[0].bg,
      sailor_frame: { displayEdge: 640 },
    },
    mode: 0,
  },
})

const current = ref(0)
function loadLook(i: number) {
  current.value = i
  node.data.properties.sailor_localLayers = LOOKS[i].layers()
  node.data.properties.sailor_localBg = LOOKS[i].bg
}

const nodes = ref<any[]>([node])
const edges = ref<any[]>([])
provide('vueFlowNodes', nodes)
provide('vueFlowEdges', edges)

const flowNodes = [{ id: 'n1', type: 'artifact-frame', position: { x: 64, y: 84 }, data: node.data }]
const nodeTypes = { 'artifact-frame': markRaw(ArtifactFrameNode) } as any

const modalOpen = ref(false)
const ready = ref(false)
onMounted(async () => {
  ready.value = true
  ;(window as any).__looks = { node, nodes, LOOKS, loadLook }
  // Re-nudge once the spike fonts load, so the canvas re-renders with them
  // instead of the fallback it first painted.
  try { await (document as any).fonts?.ready; loadLook(current.value) } catch { /* no font API */ }
})
</script>

<template>
  <div class="fixed inset-0 bg-[#0b0d12]" :data-ready="ready ? '' : undefined">
    <div class="absolute inset-0 grid place-items-center text-white/[0.05] text-[80px] font-bold select-none">
      looks
    </div>

    <VueFlow
      v-if="ready"
      class="absolute inset-0"
      :nodes="flowNodes"
      :edges="[]"
      :node-types="nodeTypes"
      :min-zoom="0.2"
      :max-zoom="2"
      :nodes-draggable="true"
      :pan-on-scroll="true"
    />

    <div v-if="ready" class="absolute top-3 left-1/2 -translate-x-1/2 z-[200] flex max-w-[92vw] flex-wrap items-center justify-center gap-1.5 rounded-xl bg-black/50 px-2 py-2 backdrop-blur">
      <button
        v-for="(l, i) in LOOKS" :key="l.name"
        class="rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors"
        :class="current === i ? 'bg-white text-black' : 'bg-white/10 text-white/80 hover:bg-white/20'"
        @click="loadLook(i)"
      >{{ l.name }}</button>
      <div class="mx-1 h-5 w-px bg-white/15"></div>
      <button
        class="rounded-lg bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white/80 hover:bg-white/20"
        @click="modalOpen = !modalOpen"
      >{{ modalOpen ? 'Close editor' : 'Adjust' }}</button>
    </div>

    <CompositorModal
      v-if="ready && modalOpen"
      :node-id="'n1'" :nodes="nodes" :edges="edges" @close="modalOpen = false"
    />
  </div>
</template>
