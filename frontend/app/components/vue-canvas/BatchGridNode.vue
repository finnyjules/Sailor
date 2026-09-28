<script setup lang="ts">
// Frontend-only results pile from a Smart Layout batch export — chromeless
// like the artifact cards: a slightly disorderly stack of outputs with a
// count badge. Clicking the pile selects the node (Vue Flow default,
// mirrored by the selection ring on the cover); explicit actions live in
// the top-right rail under the badge: expand (gallery) + ZIP.
// The gallery modal is owned by VueNodeCanvas (codebase convention —
// node-local modal state doesn't survive Vue Flow node re-renders). Data
// lives in properties.sailor_batch and rehydrates with the workflow.
import { Download, Loader2, Maximize2 } from 'lucide-vue-next'
import { BATCH_PROP, type BatchGridPayload } from '~/lib/collection/matrix'
import { downloadBatchZip } from '~/lib/collection/batchZip'
import PileStack from './PileStack.vue'

const props = defineProps<{ id: string; data: any; selected?: boolean }>()

const payload = computed<BatchGridPayload | null>(
  () => props.data?.properties?.[BATCH_PROP] ?? null)
const items = computed(() => payload.value?.items ?? [])

function openGallery() {
  window.dispatchEvent(new CustomEvent('sailor:openBatchGallery', { detail: { nodeId: props.id } }))
}

const zipping = ref(false)
async function downloadZip() {
  if (zipping.value || !payload.value) return
  zipping.value = true
  try {
    await downloadBatchZip(payload.value)
  } finally {
    zipping.value = false
  }
}

const btnCls = 'size-7 rounded-md bg-black/55 hover:bg-black/75 backdrop-blur-sm border border-white/15 '
  + 'flex items-center justify-center text-white/75 hover:text-white transition-colors cursor-pointer disabled:opacity-50 shadow-md'
</script>

<template>
  <div class="content-card w-[220px] select-none" :data-selected="selected || undefined">
    <div class="content-card__name">
      <span class="truncate flex-1 min-w-0">Batch</span>
    </div>
    <!-- The pile: clicking selects the node, dragging moves it (no handlers
         here on purpose). -->
    <PileStack :images="items.map(i => i.url)" :seed-key="String(props.id)" :selected="selected">
      <template #rail>
        <button :class="btnCls" title="Expand" @click.stop="openGallery">
          <Maximize2 class="size-3.5" />
        </button>
        <button :class="btnCls" title="Download all (ZIP)" :disabled="zipping" @click.stop="downloadZip">
          <Loader2 v-if="zipping" class="size-3.5 animate-spin" />
          <Download v-else class="size-3.5" />
        </button>
      </template>
    </PileStack>
  </div>
</template>
