<script setup lang="ts">
// One inspector action (redesign 2026-09-25): the AI star (pastel means AI; a
// non-AI row keeps the slot empty so the names line up), the name, one plain line
// underneath saying what comes back, and the price on the right of the name. Same type as the
// control rows around it — 11px, the white/72·45 greys, a 6px radius, a
// white/[0.05]-family hover — so it reads as part of the panel, not a pill.
// The name never truncates (it must fit); the description does, at its end.
import { computed } from 'vue'
import AiMark from '~/components/prompt/AiMark.vue'
import { runStudioAction, type StudioAction } from '~/lib/studio/studioActions'
import type { StudioPromptApi } from '~/composables/useStudioPrompt'
import { hostedModeEnabled } from '~/lib/hostedMode'

const props = defineProps<{ action: StudioAction; prompt?: Pick<StudioPromptApi, 'setMode' | 'runKind'> | null }>()
const emit = defineEmits<{ ran: [] }>()

// Guarded: unit hosts have no Nuxt runtime config.
const hosted = (): boolean => { try { return hostedModeEnabled(useRuntimeConfig().public) } catch { return false } }
const price = computed(() => (props.action.priceFor ? props.action.priceFor(hosted()) : null))
const line = computed(() => (props.action.disabled && props.action.disabledHint ? props.action.disabledHint : props.action.description))

function run() {
  if (props.action.disabled) return
  runStudioAction(props.action, props.prompt ?? null)
  emit('ran')
}
</script>

<template>
  <button type="button" data-testid="studio-action-row" :data-action-id="action.id"
          :disabled="action.disabled" :title="action.disabled ? action.disabledHint : undefined"
          class="group flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/40 disabled:cursor-default disabled:hover:bg-transparent"
          @click="run">
    <span class="flex h-4 w-3 shrink-0 items-center justify-center" :class="{ 'opacity-40': action.disabled }">
      <AiMark v-if="action.ai" kind="star" class="size-3" />
    </span>
    <!-- Name and price share the first line; the description runs the full width beneath,
         under the price too, so it gets the room the price column would have wasted. -->
    <span class="min-w-0 flex-1" :class="{ 'opacity-40': action.disabled }">
      <span class="flex items-baseline justify-between gap-2">
        <span data-testid="studio-action-name" class="whitespace-nowrap text-[11px] font-medium leading-4 text-white/85">{{ action.label }}</span>
        <span v-if="price && !action.disabled" data-testid="studio-action-price"
              class="shrink-0 whitespace-nowrap text-[11px] leading-4 tabular-nums text-white/45">{{ price }}</span>
      </span>
      <span :data-testid="action.disabled && action.disabledHint ? 'studio-action-disabled-hint' : 'studio-action-description'"
            class="block truncate text-[11px] leading-4 text-white/45" :title="line">{{ line }}</span>
    </span>
  </button>
</template>
