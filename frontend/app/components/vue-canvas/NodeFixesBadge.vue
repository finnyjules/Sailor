<script setup lang="ts">
// "N fixes" — the reviewer found fixes for this node (spec §2.3). Fixes are AI,
// so the pill wears the pastel hairline. A click opens the node toolbar's
// Edit ▾, where the fixes lead the menu (VueNodeCanvas listens).
import { computed } from 'vue'
import { useNextStepsStrip } from '~/composables/useNextStepsStrip'

const props = defineProps<{ nodeId: string }>()

const { fixesFor } = useNextStepsStrip()
const count = computed(() => fixesFor(props.nodeId).length)
const label = computed(() => (count.value === 1 ? '1 fix' : `${count.value} fixes`))

function open() {
  window.dispatchEvent(new CustomEvent('sailor:openNodeEdit', { detail: { nodeId: props.nodeId } }))
}
</script>

<template>
  <button
    v-if="count > 0"
    type="button"
    class="node-fixes-badge pastel-hairline nopan nodrag shrink-0 h-[18px] px-1.5 rounded-full text-[9.5px] font-medium leading-none text-white/80 hover:text-white cursor-pointer tabular-nums"
    :title="`Suggested fixes: ${label}`"
    @click.stop="open"
    @pointerdown.stop
  >{{ label }}</button>
</template>
