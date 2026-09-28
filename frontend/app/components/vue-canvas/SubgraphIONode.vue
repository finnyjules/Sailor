<script setup lang="ts">
import { getTypeColor } from '~/composables/useVueNodes'
import { minHeightForPorts } from '~/lib/canvas/portLayout'
import { useNodeGlass } from '~/composables/useCanvasGlass'

const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    nodeType: string
    title: string
    inputs: { name: string; type: string; link: number | null }[]
    outputs: { name: string; type: string; links: number[] | null }[]
    isInput: boolean
    size?: [number, number]
  }
}>()

const portsMinHeight = computed(() =>
  minHeightForPorts(props.data.isInput ? props.data.outputs.length : props.data.inputs.length),
)

// Real blur behind the glass shell when the canvas asks for it (data-glass-blur).
const glass = useNodeGlass(() => props.id)
</script>

<template>
  <!-- Ports sit outside the card so its background occludes their inner half.
       An input boundary exposes outputs and vice versa: data flows OUT from an
       input boundary INTO the subgraph. -->
  <div class="relative w-fit">
    <VueCanvasNodePort
      v-for="(port, i) in (data.isInput ? data.outputs : data.inputs)"
      :id="data.isInput ? `output-${i}` : `input-${i}`"
      :key="`port-${i}`"
      :type="data.isInput ? 'source' : 'target'"
      :side="data.isInput ? 'right' : 'left'"
      :index="i"
      :data-type="port.type"
      :label="port.name"
    />

  <div
    class="subgraph-io node-shell relative z-10 select-none min-w-[180px]"
    :data-selected="selected || undefined"
    :data-glass-blur="glass || undefined"
    :style="{
      // Absolutely positioned ports can't hold the node open themselves.
      minHeight: `${portsMinHeight}px`,
      // A visible border is a signal here (subgraph boundary), so it stays inline
      // rather than folding into the shell's own even edge.
      borderColor: 'rgba(255,255,255,0.3)',
    }"
  >
    <!-- Title bar -->
    <div class="flex items-center gap-2 px-3 py-2 border-b border-white/15">
      <!-- Arrow icon -->
      <svg v-if="data.isInput" class="size-3.5 text-white/70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
      <svg v-else class="size-3.5 text-white/70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6" />
      </svg>
      <span class="text-[13px] font-semibold truncate" :class="data.isInput ? 'text-white/70' : 'text-white/70'">
        {{ data.title }}
      </span>
    </div>

    <!-- Spacer: reserves the vertical room the centred port stack needs. -->
    <div class="py-2" />
  </div>
  </div>
</template>

