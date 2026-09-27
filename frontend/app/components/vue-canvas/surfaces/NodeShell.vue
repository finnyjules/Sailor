<script setup lang="ts">
/** The instrument/studio shell. Chrome only: each node fills the slots. See node-surfaces.css. */
import { inject } from 'vue'
import { NodeIdInjection } from '@vue-flow/core'
import { useNodeGlass } from '~/composables/useCanvasGlass'
const props = defineProps<{ title: string; nodeId?: string; selected?: boolean }>()
// Inside a Vue Flow node the id is injected, so a caller that forgets nodeId still gets blur.
const injectedNodeId = inject(NodeIdInjection, undefined)
const glass = useNodeGlass(() => props.nodeId ?? injectedNodeId)
</script>

<template>
  <div class="node-shell" :data-glass-blur="glass || undefined" :data-selected="selected || undefined">
    <div class="node-shell__head">
      <span class="node-shell__icon"><slot name="icon" /></span>
      <span class="node-shell__title">{{ title }}</span>
      <div v-if="$slots.actions" class="node-shell__actions"><slot name="actions" /></div>
    </div>
    <div class="node-shell__body"><slot /></div>
    <div v-if="$slots.foot" class="node-shell__foot"><slot name="foot" /></div>
  </div>
</template>
