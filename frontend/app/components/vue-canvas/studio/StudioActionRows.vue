<script setup lang="ts">
// Inspector actions as light rows (spec §2.4): Edit, then Develop, under the
// thing itself and above the dials. Each row: the label, and on the right the
// landing hint ("3 takes") plus the ✦ on AI rows. No primary button.
import { computed } from 'vue'
import AiMark from '~/components/prompt/AiMark.vue'
import { landsHint, type ActionGroup } from '~/lib/canvas/nodeActions'
import { runStudioAction, type StudioAction } from '~/lib/studio/studioActions'
import { useStudioPromptApi, type StudioPromptApi } from '~/composables/useStudioPrompt'

const props = defineProps<{ actions: StudioAction[]; prompt?: StudioPromptApi; bare?: boolean }>()

const injected = useStudioPromptApi()
const api = computed(() => props.prompt ?? injected)

const GROUPS: { id: ActionGroup; label: string }[] = [
  { id: 'edit', label: 'Edit' },
  { id: 'develop', label: 'Develop' },
]
const sections = computed(() =>
  props.bare
    ? [{ id: 'all', label: '', rows: props.actions }]
    : GROUPS.map(g => ({ ...g, rows: props.actions.filter(a => a.group === g.id) })).filter(s => s.rows.length > 0),
)

function run(a: StudioAction) { runStudioAction(a, api.value) }
</script>

<template>
  <div data-testid="studio-actions" class="space-y-2.5">
    <section v-for="s in sections" :key="s.id" class="space-y-1">
      <h4 v-if="!bare" class="px-0.5 text-[11px] font-medium text-white/45">{{ s.label }}</h4>
      <button v-for="a in s.rows" :key="a.id" type="button"
              data-testid="studio-action-row" :data-action-id="a.id"
              class="flex w-full items-center justify-between gap-2 rounded-[7px] bg-white/[0.05] px-[9px] py-1.5 text-left text-[12.5px] text-white/85 transition-colors hover:bg-white/[0.08]"
              @click="run(a)">
        <span class="min-w-0 truncate">{{ a.label }}</span>
        <span class="flex shrink-0 items-center gap-1.5">
          <span v-if="landsHint(a.lands)" class="text-[11px] text-white/45">{{ landsHint(a.lands) }}</span>
          <AiMark v-if="a.ai" kind="star" class="size-3" />
        </span>
      </button>
    </section>
  </div>
</template>
