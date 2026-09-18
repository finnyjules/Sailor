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
      // A 16×16 poster grid — a fine modular grid for precise alignment; the
      // module doubles as the baseline the small text snaps to. Guides show in
      // the editor and tuning snaps to them. Shared across the looks.
      sailor_localGrid: {
        mode: 'explicit', columns: 16, rows: 16, margin: 0.04, gutter: 0.006,
        baseModule: 1 / 16, overlay: true,
      },
    },
    mode: 0,
  },
})

// Julien's saved tunings, name → { bg, layers }. Merged over the spike defaults
// so an adjusted look survives a reload (persisted by /api/dev-looks).
const tuned = ref<Record<string, { bg: string; layers: any[] }>>({})
const clone = (v: any) => JSON.parse(JSON.stringify(v))

const current = ref(0)
function loadLook(i: number) {
  current.value = i
  const t = tuned.value[LOOKS[i].name]
  node.data.properties.sailor_localLayers = t ? clone(t.layers) : LOOKS[i].layers()
  node.data.properties.sailor_localBg = t ? t.bg : LOOKS[i].bg
}

const saveState = ref<'' | 'saving' | 'saved' | 'error'>('')
async function saveDefault() {
  const name = LOOKS[current.value].name
  const bg = node.data.properties.sailor_localBg
  const layers = clone(node.data.properties.sailor_localLayers)
  saveState.value = 'saving'
  try {
    await $fetch('/api/dev-looks', { method: 'POST', body: { name, bg, layers } })
    tuned.value = { ...tuned.value, [name]: { bg, layers } }
    saveState.value = 'saved'
    setTimeout(() => { if (saveState.value === 'saved') saveState.value = '' }, 2000)
  } catch { saveState.value = 'error' }
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
  // Pull any saved tunings, then load the current look so overrides apply.
  try { tuned.value = (await $fetch('/api/dev-looks')) as any } catch { /* none saved */ }
  loadLook(current.value)
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

    <div
      v-if="ready"
      class="absolute left-1/2 z-[200] flex max-w-[92vw] flex-wrap items-center justify-center gap-1.5 rounded-xl bg-black/50 px-2 py-2 backdrop-blur"
      :class="modalOpen ? 'bottom-3 -translate-x-1/2' : 'top-3 -translate-x-1/2'"
    >
      <button
        v-for="(l, i) in LOOKS" :key="l.name"
        v-show="!modalOpen"
        class="rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors"
        :class="current === i ? 'bg-white text-black' : 'bg-white/10 text-white/80 hover:bg-white/20'"
        @click="loadLook(i)"
      >{{ l.name }}<span v-if="tuned[l.name]" class="ml-1 text-emerald-400">•</span></button>
      <div v-show="!modalOpen" class="mx-1 h-5 w-px bg-white/15"></div>
      <span v-if="modalOpen" class="px-1 text-[12px] font-medium text-white/60">{{ LOOKS[current].name }}</span>
      <button
        class="rounded-lg bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white/80 hover:bg-white/20"
        @click="modalOpen = !modalOpen"
      >{{ modalOpen ? 'Close editor' : 'Adjust' }}</button>
      <button
        class="rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors"
        :class="saveState === 'error' ? 'bg-red-500/20 text-red-300' : saveState === 'saved' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/10 text-white/80 hover:bg-white/20'"
        @click="saveDefault"
      >{{ saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓' : saveState === 'error' ? 'Save failed' : 'Save as default' }}</button>
    </div>

    <CompositorModal
      v-if="ready && modalOpen"
      :node-id="'n1'" :nodes="nodes" :edges="edges" @close="modalOpen = false"
    />
  </div>
</template>
