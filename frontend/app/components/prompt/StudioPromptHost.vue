<script setup lang="ts">
// The one prompt in a studio (spec §2.1a, §2.4). A thin template around
// SailorPrompt: the api (useStudioPrompt) owns the behaviour, the owner decides
// the width. Result cards sit in SailorPrompt's `above` slot, exactly as on the
// canvas. `/` and ⌘K focus it while mounted, and stop there so the canvas prompt
// under the modal never takes the key (plan ruling 11).
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import SailorPrompt from '~/components/prompt/SailorPrompt.vue'
import PromptTakes from '~/components/prompt/PromptTakes.vue'
import PromptChangesCard from '~/components/prompt/PromptChangesCard.vue'
import PromptAnswerCard from '~/components/prompt/PromptAnswerCard.vue'
import { shouldFocusPrompt } from '~/lib/prompt/sailorPrompt'
import type { StudioPromptApi } from '~/composables/useStudioPrompt'

const props = defineProps<{ prompt: StudioPromptApi }>()
const p = props.prompt
const promptRef = ref<InstanceType<typeof SailorPrompt> | null>(null)

function focus() { promptRef.value?.focus() }
watch(() => p.focusTick.value, () => focus())

// Only a field that is on screen claims the key (null while working): a host
// that isn't — unmounted, or hidden by a v-show / display:none ancestor, like
// Frame's prompt during a pen session — must leave `/` to whoever is.
function isOnScreen(el: HTMLElement | null | undefined): el is HTMLElement {
  return !!el?.isConnected && el.getClientRects().length > 0
}
function onKey(e: KeyboardEvent) {
  if (!shouldFocusPrompt(e) || !isOnScreen(promptRef.value?.inputElement())) return
  e.preventDefault()
  e.stopImmediatePropagation()
  focus()
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
defineExpose({ focus })
</script>

<template>
  <div data-testid="studio-prompt" class="w-full min-w-0">
    <!-- In a studio the chip is the thing being edited: its × can't deselect it,
         so it clears the mode instead (harmless when there is none). -->
    <SailorPrompt
      ref="promptRef"
      :selection-label="p.chipLabel.value"
      :mode="p.mode.value?.label ?? null"
      :note="p.modeNote.value"
      :suggestions="p.suggestions.value"
      :working="p.working.value"
      :working-label="p.workingLabel.value"
      :disabled="p.disabled.value"
      @submit="p.submit"
      @stop="p.stop"
      @clear-mode="p.clearMode"
      @clear-selection="p.clearMode"
    >
      <template v-if="p.card.value" #above>
        <PromptTakes
          v-if="p.card.value === 'takes' && p.takes.value"
          :session="p.takes.value" :saving="p.takesSaving.value" :error="p.takesError.value" :more-note="p.takesMoreNote?.value ?? null"
          @hover="p.previewTake" @choose="p.chooseTake" @keep="p.keepTake" @more="p.moreTakes" @close="p.closeTakes"
        />
        <PromptChangesCard
          v-else-if="p.card.value === 'changes' && p.worker()"
          :changes="p.worker()!.changes.value" :busy="p.worker()!.busy.value"
          :issues="p.worker()!.issues?.value" :review="p.worker()!.review.value" :reviewing="p.worker()!.reviewing.value"
          :runnable="false"
          @accept="p.worker()!.acceptChange" @reject="p.worker()!.rejectChange" @reroll="p.worker()!.reroll"
          @approve="p.approve" @reject-all="p.rejectAll" @hover="(i: number | null) => (p.worker()!.hovered.value = i)"
        />
        <PromptAnswerCard
          v-else-if="p.card.value === 'answer' && p.answerCard.value"
          :card="p.answerCard.value"
          @close="p.dismissAnswer" @follow-up="p.runFollowUp"
        />
      </template>
    </SailorPrompt>
  </div>
</template>
