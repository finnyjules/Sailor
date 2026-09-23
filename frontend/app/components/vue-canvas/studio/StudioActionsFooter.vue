<script setup lang="ts">
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioFooterMenu from '~/components/vue-canvas/studio/StudioFooterMenu.vue'
import { resolveStatus, type StudioFooterSpec } from '~/lib/studio/footer'
import { computed } from 'vue'

// `stacked`: for a footer in a narrow side panel (the Frame editor's), where the two menus
// fill the width on their own. Utilities and status move to a line of their own above them;
// the menus spread to the two edges, and the Download menu, now at the left edge, opens
// rightwards so the panel's clipping cannot cut it off.
// Without it the two groups are `display: contents`, so the footer is the one row it always was.
const props = defineProps<{ spec: StudioFooterSpec; stacked?: boolean }>()
const status = computed(() => resolveStatus(props.spec.status))
const toneClass: Record<string, string> = {
  error: 'text-red-400/90', saved: 'text-emerald-400/80', saving: 'text-white/50', notice: 'text-white/55',
}
</script>

<template>
  <div class="flex w-full gap-2" :class="stacked ? 'flex-col' : 'items-center'">
    <!-- ① utilities + status (left, quiet) — utilities first so a status text whose
         width changes every frame (e.g. "Rendering 12/120") never shifts them sideways -->
    <div v-if="spec.utilities?.length || status" :class="stacked ? 'flex min-w-0 items-center gap-2' : 'contents'">
      <StudioButton
        v-for="(u, i) in spec.utilities" :key="'u' + i"
        variant="subtle" :disabled="u.disabled || u.busy" :data-testid="u.testId" @click="u.onClick">
        <span class="flex items-center gap-1.5">
          <component :is="u.icon" v-if="u.icon" class="h-3.5 w-3.5" />
          {{ u.busy ? 'Working…' : u.label }}
        </span>
      </StudioButton>
      <p v-if="status" class="truncate text-xs tabular-nums" :class="toneClass[status.tone]" :title="stacked ? status.text : undefined">{{ status.text }}</p>
    </div>
    <div :class="stacked ? 'flex items-center justify-between gap-2' : 'contents'">
      <span v-if="!stacked" class="flex-1" />
      <!-- ② download ▾ -->
      <StudioFooterMenu v-if="spec.downloads?.length" label="Download" variant="secondary" :align="stacked ? 'start' : 'end'" :actions="spec.downloads" />
      <!-- ③ render on canvas ▾ -->
      <StudioFooterMenu v-if="spec.canvas?.length" label="Render on canvas" variant="primary" :actions="spec.canvas" />
    </div>
  </div>
</template>
