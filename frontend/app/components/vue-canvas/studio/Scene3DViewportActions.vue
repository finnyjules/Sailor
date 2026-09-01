<script setup lang="ts">
// Contextual selection-verb bar, floated top-center of the 3D viewport, shown
// while NOT sculpting whenever the selection has an applicable verb. Selection
// is transient, so this leaves the bottom add/create shelf in place; sculpt is
// the sustained mode that takes over the bottom dock instead. Presentational
// only — every verb is an emit the surface handles; local state is just the
// three popovers.
import { ref } from 'vue'
import { Group, Ungroup, Paintbrush, Combine, Boxes, MoreHorizontal, Loader2 } from 'lucide-vue-next'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import { REMESH_RESOLUTION_MAX } from '~/lib/scene3d/toMesh'

const props = defineProps<{
  canGroup: boolean
  canUngroup: boolean
  canEnterSculpt: boolean
  canConvertToMesh: boolean
  canMerge: boolean
  sculptConfirmNeeded: boolean
  selectedKindLabel: string
  mergeBusy?: boolean
  converting?: boolean
}>()

const mergeOp = defineModel<string>('mergeOp', { required: true })
const mergeBlend = defineModel<number>('mergeBlend', { required: true })
const mergeResolution = defineModel<number>('mergeResolution', { required: true })

const emit = defineEmits<{ group: []; ungroup: []; convert: []; sculpt: []; merge: []; suppressConfirm: [] }>()

const mergeOpen = ref(false)
const overflowOpen = ref(false)
const confirmOpen = ref(false)
const dontAskAgain = ref(false)

function onSculptClick() {
  if (props.sculptConfirmNeeded) { confirmOpen.value = true; return }
  emit('sculpt')
}
function confirmSculpt() {
  if (dontAskAgain.value) emit('suppressConfirm')
  confirmOpen.value = false
  emit('sculpt')
}
</script>

<template>
  <div class="pointer-events-auto flex items-center gap-1 rounded-[12px] border border-white/10 bg-[#1a1a1a]/95 p-1.5 shadow-lg backdrop-blur" @pointerdown.stop>
    <StudioButton v-if="canGroup" @click="$emit('group')"><span class="flex items-center gap-1.5"><Group class="h-3.5 w-3.5" /> Group</span></StudioButton>
    <StudioButton v-if="canUngroup" @click="$emit('ungroup')"><span class="flex items-center gap-1.5"><Ungroup class="h-3.5 w-3.5" /> Ungroup</span></StudioButton>

    <!-- Sculpt: unified convert-then-sculpt. Confirm popover only when the
         selection is a non-mesh primitive and the confirm isn't suppressed. -->
    <div v-if="canEnterSculpt" class="relative">
      <StudioButton variant="primary" @click="onSculptClick"><span class="flex items-center gap-1.5"><Paintbrush class="h-3.5 w-3.5" /> Sculpt</span></StudioButton>
      <div v-if="confirmOpen" class="absolute left-0 top-full mt-2 w-64 space-y-2 rounded-lg border border-white/10 bg-[#1a1a1a] p-3 text-[12px] shadow-xl">
        <p class="leading-snug text-white/80">Sculpting freezes this {{ selectedKindLabel }} to an editable mesh — its parameters will be replaced.</p>
        <label class="flex items-center gap-1.5 text-[11px] text-white/55"><input v-model="dontAskAgain" type="checkbox" /> Don't ask again</label>
        <div class="flex justify-end gap-2">
          <StudioButton variant="secondary" @click="confirmOpen = false">Cancel</StudioButton>
          <StudioButton variant="primary" @click="confirmSculpt">Sculpt</StudioButton>
        </div>
      </div>
    </div>

    <!-- Merge popover -->
    <div v-if="canMerge" class="relative">
      <StudioButton @click="mergeOpen = !mergeOpen; overflowOpen = false"><span class="flex items-center gap-1.5"><Combine class="h-3.5 w-3.5" /> Merge</span></StudioButton>
      <div v-if="mergeOpen" class="absolute left-0 top-full mt-2 w-64 space-y-2 rounded-lg border border-white/10 bg-[#1a1a1a] p-3 shadow-xl">
        <StudioSegmented v-model="mergeOp" :options="['union', 'subtract', 'intersect']" />
        <p v-if="mergeOp === 'subtract'" class="text-[11px] leading-snug text-white/45">Subtracts everything else FROM the first selected object.</p>
        <StudioSlider v-model="mergeBlend" label="Blend" :min="0" :max="0.3" :step="0.01" />
        <StudioSlider v-model="mergeResolution" label="Resolution" :min="16" :max="REMESH_RESOLUTION_MAX" :step="1" />
        <StudioButton :disabled="mergeBusy" @click="$emit('merge')"><span class="flex items-center gap-1.5"><Loader2 v-if="mergeBusy" class="h-3.5 w-3.5 animate-spin" />{{ mergeBusy ? 'Merging…' : 'Merge' }}</span></StudioButton>
      </div>
    </div>

    <!-- Overflow: Convert to mesh (freeze without sculpting) -->
    <div v-if="canConvertToMesh" class="relative">
      <StudioButton variant="subtle" @click="overflowOpen = !overflowOpen; mergeOpen = false"><MoreHorizontal class="h-4 w-4" /></StudioButton>
      <div v-if="overflowOpen" class="absolute right-0 top-full mt-2 w-48 rounded-lg border border-white/10 bg-[#1a1a1a] p-1 shadow-xl">
        <button type="button" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/80 hover:bg-white/10 disabled:opacity-40" :disabled="converting" @click="overflowOpen = false; $emit('convert')"><Boxes class="h-3.5 w-3.5" /> Convert to mesh</button>
      </div>
    </div>
  </div>
</template>
