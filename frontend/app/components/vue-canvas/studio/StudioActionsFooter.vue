<script setup lang="ts">
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioFooterMenu from '~/components/vue-canvas/studio/StudioFooterMenu.vue'
import { resolveStatus, type StudioFooterSpec } from '~/lib/studio/footer'
import { computed } from 'vue'

const props = defineProps<{ spec: StudioFooterSpec }>()
const status = computed(() => resolveStatus(props.spec.status))
const toneClass: Record<string, string> = {
  error: 'text-red-400/90', saved: 'text-emerald-400/80', saving: 'text-white/50', notice: 'text-white/55',
}
</script>

<template>
  <div class="flex w-full items-center gap-2">
    <!-- ① utilities + status (left, quiet) — utilities first so a status text whose
         width changes every frame (e.g. "Rendering 12/120") never shifts them sideways -->
    <StudioButton
      v-for="(u, i) in spec.utilities" :key="'u' + i"
      variant="subtle" :disabled="u.disabled || u.busy" @click="u.onClick">
      <span class="flex items-center gap-1.5">
        <component :is="u.icon" v-if="u.icon" class="h-3.5 w-3.5" />
        {{ u.busy ? 'Working…' : u.label }}
      </span>
    </StudioButton>
    <p v-if="status" class="truncate text-xs tabular-nums" :class="toneClass[status.tone]">{{ status.text }}</p>
    <span class="flex-1" />
    <!-- ② download ▾ -->
    <StudioFooterMenu v-if="spec.downloads?.length" label="Download" variant="secondary" :actions="spec.downloads" />
    <!-- ③ render on canvas ▾ -->
    <StudioFooterMenu v-if="spec.canvas?.length" label="Render on canvas" variant="primary" :actions="spec.canvas" />
  </div>
</template>
