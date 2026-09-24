<!-- frontend/app/components/vue-canvas/compositor/LayoutSetSection.vue -->
<script setup lang="ts">
// The Layout tab's "Make a set" section (Stage 5): the formats to recompose the Frame's layout
// at, grouped as the Size menu groups them (Social / Display ads — `frameFormatGroup`), and the
// button that opens the set sheet. Collapsed until opened. The ticked formats are emitted; the
// host remembers them on the Frame (no history step).
import { computed, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import { FRAME_FORMATS, frameFormatGroup } from '~/lib/frame/formats'
import type { FrameFormatGroup } from '~/lib/frame/formats'

const props = defineProps<{
  /** The ticked format ids. */
  formats: readonly string[]
}>()
const emit = defineEmits<{
  (e: 'update:formats', ids: string[]): void
  (e: 'open'): void
}>()

const expanded = ref(false)
const GROUP_ORDER: FrameFormatGroup[] = ['Social', 'Display ads']
const GROUPS = GROUP_ORDER.map(name => ({ name, formats: FRAME_FORMATS.filter(f => frameFormatGroup(f.id) === name) }))

const ticked = computed(() => new Set(props.formats))
/** Toggle one format; emitted in `FRAME_FORMATS` order. */
function toggle(id: string, on: boolean) {
  const next = new Set(ticked.value)
  if (on) next.add(id)
  else next.delete(id)
  emit('update:formats', FRAME_FORMATS.filter(f => next.has(f.id)).map(f => f.id))
}
</script>

<template>
  <div class="flex flex-col gap-2" data-testid="layout-set-section">
    <button
      type="button" class="flex items-center gap-2 text-left cursor-pointer"
      :aria-expanded="expanded" data-testid="layout-set-toggle"
      @click="expanded = !expanded">
      <span class="text-sm font-medium text-white/90">Make a set</span>
      <ChevronDown class="ml-auto size-3.5 text-white/45 transition-transform" :class="expanded ? 'rotate-180' : ''" />
    </button>
    <template v-if="expanded">
      <div v-for="g in GROUPS" :key="g.name" class="flex flex-col gap-1" data-testid="layout-set-group" :data-group="g.name">
        <span class="text-[11px] text-white/55">{{ g.name }}</span>
        <label
          v-for="f in g.formats" :key="f.id"
          class="flex items-center gap-2 text-[12px] text-white/80 cursor-pointer" data-testid="layout-set-format" :data-format="f.id">
          <input
            type="checkbox" class="accent-white/80" :checked="ticked.has(f.id)"
            @change="toggle(f.id, ($event.target as HTMLInputElement).checked)">
          <span class="truncate">{{ f.label }}</span>
        </label>
      </div>
      <StudioButton variant="secondary" class="w-full" :disabled="!formats.length" data-testid="layout-set-open" @click="emit('open')">
        Open the set
      </StudioButton>
    </template>
  </div>
</template>
