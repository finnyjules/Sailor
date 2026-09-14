<script setup lang="ts">
/** Looks gallery — a prototype of the "adopt a look" direction.
 *
 *  Each LOOK is a hand-authored poster, expressed as real Frame layers
 *  (sailor_localLayers + a background). Pick one and it loads into a single
 *  portrait Frame you can open in the Compositor and adjust like any other —
 *  drag the type, recolour it, change a word. Nothing here is generated; the
 *  looks are designed. Reachable only at /dev/looks. Hard-reload after editing.
 *
 *  This is a proving ground for whether authored looks (not procedural
 *  rearrangement) is the right model. It is NOT a saved project yet. */
import { VueFlow } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import CompositorModal from '~/components/vue-canvas/CompositorModal.vue'
import ArtifactFrameNode from '~/components/vue-canvas/ArtifactFrameNode.vue'
import type { LocalLayer } from '~/composables/useCompositorLayers'

definePageMeta({ layout: false })

const INK = '#141413'
const RED = '#e2231a'
const CREAM = '#f3efe6'

let seq = 0
function t(o: Partial<any>): any {
  return {
    id: 'L' + (seq++), kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    text: '', fontFamily: 'Inter', fontWeight: 900, fontSize: 0.2, color: INK,
    align: 'left', lineHeight: 0.9, letterSpacing: 0, strokeColor: '#000', strokeWidth: 0, ...o,
  }
}
function rect(o: Partial<any>): any {
  return { id: 'R' + (seq++), kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.3, h: 0.1, fill: INK, stroke: '', strokeWidth: 0, radius: 0, ...o }
}

interface Look { name: string; bg: string; layers: () => LocalLayer[] }

const LOOKS: Look[] = [
  {
    name: 'Stack',
    bg: '#ffffff',
    layers: () => [
      t({ text: 'NOISE', x: 0.5, y: 0.30, fontSize: 0.30, color: INK }),
      t({ text: 'NOISE', x: 0.5, y: 0.46, fontSize: 0.30, color: RED }),
      t({ text: 'NOISE', x: 0.5, y: 0.62, fontSize: 0.30, color: INK }),
      t({ text: 'Talks on sound and the city', x: 0.5, y: 0.88, fontSize: 0.038, fontWeight: 600 }),
      t({ text: '12–14 October 2026 · Kunsthalle', x: 0.5, y: 0.93, fontSize: 0.028, fontWeight: 500, color: '#6b6b66' }),
    ],
  },
  {
    name: 'Run-off',
    bg: CREAM,
    layers: () => [
      t({ text: 'NOISE', x: 0.32, y: 0.5, fontSize: 0.62, color: INK, lineHeight: 0.82 }),
      t({ text: 'Talks on sound\nand the city', x: 0.08, y: 0.9, fontSize: 0.03, fontWeight: 600, lineHeight: 1.15 }),
      t({ text: '12–14 OCT 2026', x: 0.92, y: 0.06, fontSize: 0.024, fontWeight: 700, align: 'right', letterSpacing: 0.06 }),
    ],
  },
  {
    name: 'Colour block',
    bg: '#1d4ed8',
    layers: () => [
      t({ text: 'NO\nISE', x: 0.5, y: 0.34, fontSize: 0.40, color: '#ffffff', lineHeight: 0.86 }),
      rect({ x: 0.86, y: 0.86, w: 0.12, h: 0.12 / (900 / 1200), fill: '#f5d90a', radius: 0.5 }),
      t({ text: 'Talks on sound and the city', x: 0.5, y: 0.80, fontSize: 0.036, fontWeight: 600, color: '#dbe6ff' }),
      t({ text: '12–14 OCTOBER 2026', x: 0.5, y: 0.85, fontSize: 0.026, fontWeight: 600, color: '#dbe6ff', letterSpacing: 0.06 }),
    ],
  },
  {
    name: 'Editorial',
    bg: CREAM,
    layers: () => [
      rect({ x: 0.5, y: 0.26, w: 0.84, h: 0.004, fill: '#2a2620' }),
      t({ text: 'NOISE', x: 0.5, y: 0.42, fontSize: 0.20, fontWeight: 500, color: '#2a2620', align: 'center', letterSpacing: 0.02 }),
      rect({ x: 0.5, y: 0.56, w: 0.84, h: 0.004, fill: '#2a2620' }),
      t({ text: 'TALKS ON SOUND AND THE CITY', x: 0.5, y: 0.63, fontSize: 0.028, fontWeight: 600, color: '#5a544a', align: 'center', letterSpacing: 0.16 }),
      t({ text: '12–14 October 2026', x: 0.5, y: 0.9, fontSize: 0.026, fontWeight: 500, color: '#5a544a', align: 'center' }),
    ],
  },
]

const node = reactive({
  id: 'n1',
  data: {
    nodeType: 'CompositorNode',
    title: 'Frame',
    inputs: [], outputs: [{ name: 'image', type: 'IMAGE', links: null }],
    widgetsValues: [900, 1200] as any[], widgetDefs: [{ name: 'width' }, { name: 'height' }],
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

const flowNodes = [{ id: 'n1', type: 'artifact-frame', position: { x: 64, y: 88 }, data: node.data }]
const nodeTypes = { 'artifact-frame': markRaw(ArtifactFrameNode) } as any

const modalOpen = ref(false)
const ready = ref(false)
onMounted(() => {
  ready.value = true
  ;(window as any).__looks = { node, nodes, LOOKS, loadLook }
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

    <div v-if="ready" class="absolute top-3 left-1/2 -translate-x-1/2 z-[200] flex items-center gap-2 rounded-xl bg-black/50 px-2 py-2 backdrop-blur">
      <button
        v-for="(l, i) in LOOKS" :key="l.name"
        class="rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors"
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
