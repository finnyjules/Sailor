<script setup lang="ts">
// The inspector's actions (redesign 2026-09-25), under the thing itself and above
// the dials: the rows in one card that matches the StudioSection cards below it
// (same border, fill and radius, no title), then one quiet line pointing at the
// prompt — typing is how you ask for anything the rows don't name. No Edit /
// Develop headings, no primary button.
import { computed } from 'vue'
import StudioActionRow from './StudioActionRow.vue'
import { PROMPT_HINT, PROMPT_HINT_ALONE, type StudioAction } from '~/lib/studio/studioActions'
import { useStudioPromptApi, type StudioPromptApi } from '~/composables/useStudioPrompt'

const props = defineProps<{ actions: StudioAction[]; prompt?: StudioPromptApi }>()

const injected = useStudioPromptApi()
const api = computed(() => props.prompt ?? injected)
</script>

<template>
  <div data-testid="studio-actions" class="space-y-1.5">
    <div v-if="actions.length" class="rounded-lg border border-white/[0.10] bg-white/[0.04] p-1">
      <StudioActionRow v-for="a in actions" :key="a.id" :action="a" :prompt="api" />
    </div>
    <p data-testid="studio-actions-hint" class="px-1 text-[11px] text-white/40">{{ actions.length ? PROMPT_HINT : PROMPT_HINT_ALONE }}</p>
  </div>
</template>
