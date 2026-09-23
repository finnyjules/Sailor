<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import type { StudioFooterAction } from '~/lib/studio/footer'

const props = defineProps<{
  label: string
  variant: 'primary' | 'secondary'
  actions: StudioFooterAction[]
  /** Which edge of the trigger the menu lines up with. `end` (the default) opens it leftwards
   *  from the trigger's right edge; `start` opens it rightwards, for a trigger that sits too
   *  near the left of a narrow panel for the menu to fit the other way. */
  align?: 'start' | 'end'
}>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const anyBusy = computed(() => props.actions.some(a => a.busy))

function pick(a: StudioFooterAction) {
  if (a.disabled || a.busy) return
  open.value = false
  a.onClick()
}
function onDocPointerDown(e: PointerEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true))
</script>

<template>
  <div ref="rootEl" class="relative">
    <StudioButton :variant="variant" :disabled="anyBusy" @pointerdown.stop @click="open = !open">
      {{ anyBusy ? 'Working…' : label }}
      <span class="ml-1 inline-block rotate-90 text-white/70">›</span>
    </StudioButton>
    <div v-if="open" @pointerdown.stop
         class="absolute bottom-full z-20 mb-1.5 w-60 overflow-hidden rounded-lg border border-white/10 bg-[#1a1a1e] py-1 shadow-xl"
         :class="align === 'start' ? 'left-0' : 'right-0'">
      <button v-for="(a, i) in actions" :key="i" type="button" :disabled="a.disabled || a.busy" :data-testid="a.testId"
              class="block w-full px-3 py-1.5 text-left text-xs text-white/85 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              @click="pick(a)">
        <span class="flex items-center gap-1.5">
          <component :is="a.icon" v-if="a.icon" class="h-3.5 w-3.5" />
          {{ a.busy ? 'Working…' : a.label }}
        </span>
        <span v-if="a.subtitle" class="mt-0.5 block text-[10px] leading-snug text-white/40">{{ a.subtitle }}</span>
      </button>
    </div>
  </div>
</template>
