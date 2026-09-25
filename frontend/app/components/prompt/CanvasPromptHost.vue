<script setup lang="ts">
// The canvas's one prompt (spec §2.1, §2.1a, §3): SailorPrompt plus the result
// cards above it. A thin adapter — all behaviour lives in useCanvasPrompt. The
// layout (default.vue) focuses it for `/` and ⌘K via focus() / isFocusable().
import { computed, nextTick, ref, watch } from 'vue'
import SailorPrompt from '~/components/prompt/SailorPrompt.vue'
import PromptTakes from '~/components/prompt/PromptTakes.vue'
import PromptChangesCard from '~/components/prompt/PromptChangesCard.vue'
import PromptAnswerCard from '~/components/prompt/PromptAnswerCard.vue'
import ImageSearchPickerModal from '~/components/agent/ImageSearchPickerModal.vue'
import { useCanvasPrompt } from '~/composables/useCanvasPrompt'
import { useAiStatus } from '~/composables/useAiStatus'

const props = defineProps<{ vueCanvas?: any }>()
const { aiAvailable } = useAiStatus()
const ready = computed(() => typeof props.vueCanvas?.agentSnapshot === 'function' && typeof props.vueCanvas?.agentPreview === 'function')

const {
  agent, chipLabel, suggestions, mode, focusTick, working, workingLabel, card, answerCard, takes, showSketchInstead,
  searchOpen, searchQuery, onSearchDone, submit, stop, clearMode, clearSelection, onPromptFocus,
  previewTake, chooseTake, keepTake, closeTakes, moreTakes, dismissAnswer, runFollowUp, sketchInstead,
} = useCanvasPrompt(() => props.vueCanvas ?? null)
const { changes, issues, review, reviewing, busy: agentBusy, hovered, acceptChange, rejectChange, reroll, keep, keepAndRun, dismiss } = agent

const promptRef = ref<InstanceType<typeof SailorPrompt> | null>(null)
// A menu item that needs words (Tune…) sets a mode chip and asks for focus.
watch(focusTick, async () => { await nextTick(); promptRef.value?.focus() })

// `/` and ⌘K (default.vue) ask this before focusing: the field must exist (not
// working), be enabled (AI set up), have a size, and be the top element at its
// own centre — anything else there is an overlay and the key belongs to it.
function isFocusable(): boolean {
  const input = promptRef.value?.inputElement?.() ?? null
  if (!input || input.disabled) return false
  const r = input.getBoundingClientRect()
  if (!r.width || !r.height) return false
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return !!hit && (hit === input || !!input.closest('.sailor-prompt')?.contains(hit))
}
defineExpose({ focus: () => promptRef.value?.focus(), isFocusable })
</script>

<template>
  <div v-if="ready" class="pointer-events-none flex flex-col gap-2">
    <!-- The ROOT is click-through; interactive children re-enable events (the
         stack overlays the canvas). This comment sits INSIDE the root on purpose:
         a leading template comment makes the component a fragment in dev. -->
    <ImageSearchPickerModal :open="searchOpen" :query="searchQuery" @close="searchOpen = false" @done="onSearchDone" />
    <SailorPrompt
      ref="promptRef"
      :selection-label="chipLabel"
      :mode="mode?.label ?? null"
      :suggestions="suggestions"
      :working="working"
      :working-label="workingLabel"
      :stoppable="working"
      :disabled="!aiAvailable"
      @submit="submit"
      @stop="stop"
      @clear-selection="clearSelection"
      @clear-mode="clearMode"
      @focus="onPromptFocus"
    >
      <template v-if="card" #above>
        <PromptTakes
          v-if="card === 'takes' && takes" :session="takes"
          @hover="previewTake" @choose="chooseTake" @keep="keepTake" @more="moreTakes" @close="closeTakes"
        />
        <PromptChangesCard
          v-else-if="card === 'changes'"
          :changes="changes" :busy="agentBusy" :issues="issues" :review="review" :reviewing="reviewing" runnable
          @accept="acceptChange" @reject="rejectChange" @reroll="reroll"
          @approve="keep" @approve-run="keepAndRun" @reject-all="dismiss" @hover="(i: number | null) => (hovered = i)"
        />
        <PromptAnswerCard v-else-if="card === 'answer' && answerCard" :card="answerCard" @close="dismissAnswer" @follow-up="runFollowUp" />
      </template>
    </SailorPrompt>

    <!-- "…or sketch it?" — auto-detect guessed the wrong intent. Dashed NEUTRAL
         affordance (never pastel: pastel reads as AI-generated). -->
    <div v-if="showSketchInstead" class="pointer-events-auto flex flex-wrap gap-1.5 px-1">
      <button
        type="button"
        class="rounded-full border border-dashed border-white/20 px-2.5 py-1 text-[10.5px] text-white/50 transition hover:border-white/40 hover:text-white/75"
        @click="sketchInstead"
      >…or sketch it?</button>
    </div>

    <p v-if="!aiAvailable" class="px-1 text-[11px] leading-snug text-white/40">
      AI assist isn’t set up — start the app with NUXT_ANTHROPIC_API_KEY, or paste your own key in Settings → AI.
    </p>
  </div>
</template>
