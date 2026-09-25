<script setup lang="ts">
// The canvas agent's home — a persistent prompt box that sits just above the
// canvas toolbar (Phase 3, Slice 1). Ask about the graph or tell it to edit
// nodes; results (answer / proposal) expand UPWARD above the input, which stays
// anchored just above the toolbar. The input itself is the one prompt,
// SailorPrompt (selection chip, suggestions, progress + Stop). Owns
// useCanvasAgent; the parent supplies the VueNodeCanvas ref (agentSnapshot +
// applyCanvasOps) and focuses it via the exposed focus() for `/` and ⌘K.
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { X } from 'lucide-vue-next'
import AgentProposal from '~/components/agent/AgentProposal.vue'
import SailorPrompt from '~/components/prompt/SailorPrompt.vue'
import ImageSearchPickerModal from '~/components/agent/ImageSearchPickerModal.vue'
import { useCanvasAgent } from '~/composables/useCanvasAgent'
import { useAgentActivity } from '~/composables/useAgentActivity'
import { useAiStatus } from '~/composables/useAiStatus'
import { paidProducerFor } from '~/lib/artifact/nextSteps'
import { looksLikeImageIdea } from '~/lib/sketch/sketchIntent'
import { canvasSuggestions, selectionLabel, type PromptNode } from '~/lib/prompt/canvasPromptContext'

const props = defineProps<{ vueCanvas?: any }>()
const { getLocalSetting } = useLocalSettings()
const { aiAvailable } = useAiStatus()

const ready = computed(() => typeof props.vueCanvas?.agentSnapshot === 'function' && typeof props.vueCanvas?.agentPreview === 'function')

// Misfire correction: auto-detect occasionally routes a phrase to the wrong
// intent. `lastSubmitted` is the raw text of the last user submission
// (offers "…or sketch it?" once a proposal shows up for it). Reset at
// the top of every new submission — see `go()`.
const lastSubmitted = ref('')
// Fast-path dedupe (Task 7, spec §6 lever 1): true when `go()` fast-pathed
// straight to `startSketch` THIS submit tick. If the classifier later resolves
// to `sketchIdea` too, that's the fast-path's own render finishing its round
// trip — consume the latch and skip a second pad dispatch. A plain prompt
// equality check doesn't work here: the `sketch` command hint tells the model
// to DISTILL a clean prompt, so for verbose input the classifier's prompt
// legitimately differs from the raw text while still being the same request.
// Cleared at the top of every `go()` so a later, genuine sketch still fires.
const fastPathFired = ref(false)

const {
  busy, error, reasoning, answer, changes, issues, review, reviewing, hasProposal, hovered,
  ask, stop, acceptChange, rejectChange, reroll, keep, keepAndRun, reviewLastRun, reviewNode, autoReviewNode, dismiss,
} = useCanvasAgent({
  getSnapshot: (phrase?: string) => props.vueCanvas.agentSnapshot(phrase),
  preview: (cmds, animate) => props.vueCanvas.agentPreview(cmds, animate),
  commit: () => props.vueCanvas.agentCommit(),
  frameNodes: (ids: string[]) => props.vueCanvas.agentFrameNodes(ids),
  discard: () => props.vueCanvas.agentDiscard(),
  tune: (cmds) => props.vueCanvas.agentTune(cmds, getLocalSetting('Sailor.AI.AnthropicApiKey') ?? ''),
  tuneRevert: () => props.vueCanvas.agentTuneRevert(),
  // (anatomy repairs now go through an EditImageNode the review proposes, not a route)
  // Keep & Run: run the agent's result AND anything it feeds into (direction:
  // 'downstream') — so an inserted node re-renders the output it connects to —
  // but only that affected branch, never unrelated nodes (the top Run does the
  // whole canvas). New nodes execute (uncached) and edited nodes cache-miss;
  // truly-unchanged upstream stays cached.
  run: (targetIds: string[]) => window.dispatchEvent(new CustomEvent('sailor:runFiltered', { detail: { targetIds, direction: 'downstream' } })),
  runOutputImage: (targetIds: string[]) => props.vueCanvas.agentRunOutputImage(targetIds),
  resolveResultNode: (targetIds: string[]) => props.vueCanvas.agentResolveResultNode?.(targetIds) ?? null,
  apiKey: () => getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '',
  // "find me a picture of X" → the model emits searchImages and the picker
  // takes over (search → select → import as Image nodes).
  searchImages: (query: string) => { searchQuery.value = query; searchOpen.value = true },
  // A typed image idea → the model emits `sketch` and the pad renders 4 options.
  // Dedupe against the fast-path via the `fastPathFired` latch (not a prompt
  // equality check — the classifier's distilled prompt can legitimately differ
  // from the raw text it fast-pathed): if the fast-path already fired this
  // submit tick, consume the latch and skip the redundant dispatch.
  sketchIdea: (prompt: string) => {
    if (fastPathFired.value) {
      fastPathFired.value = false
      return
    }
    if (ready.value) props.vueCanvas.startSketch?.(prompt)
  },
})

// Web-image-search picker (opened by the agent's searchImages command).
const searchOpen = ref(false)
const searchQuery = ref('')
function onSearchDone(imported: number, failed: number) {
  searchOpen.value = false
  if (imported) answer.value = `Imported ${imported} image${imported === 1 ? '' : 's'} onto the canvas.${failed ? ` ${failed} couldn’t be downloaded.` : ''}`
  else if (failed) answer.value = 'None of those images could be downloaded — try other picks.'
}

// Run→look→fix: when a Keep & Run finishes, review its output (reviewLastRun is a
// no-op unless a review is armed). VueNodeCanvas fires this on execution_complete.
function onRunComplete() { reviewLastRun() }
// On-demand "Critique" on any result node — judges its output against the prompt
// that made it (resolved by VueNodeCanvas). Fired from the node's run menu.
function onCritiqueNode(e: Event) {
  const id = (e as CustomEvent).detail?.nodeId
  if (!id || !ready.value) return
  reviewNode(String(id), props.vueCanvas.agentNodeIntent?.(String(id)) ?? '')
}
// Auto-critique: a fresh take landed on an image artifact. Gate hard —
// paid producer only, once per take, 3s settle so a Variations ×4 burst
// reviews the final state once instead of four times.
const reviewedTakes = new Map<string, string>()
const autoReviewTimers = new Map<string, ReturnType<typeof setTimeout>>()
function onAutoReview(e: Event) {
  const { nodeId, takeId } = (e as CustomEvent).detail || {}
  if (!nodeId || !takeId || !ready.value) return
  // Opt-in only: skip the post-generation critique unless the user turned it on
  // in Settings → AI. Off by default (unset === off).
  if (getLocalSetting('Sailor.AI.AutoReview') !== 'true') return
  const id = String(nodeId)
  if (reviewedTakes.get(id) === String(takeId)) return
  clearTimeout(autoReviewTimers.get(id))
  autoReviewTimers.set(id, setTimeout(() => {
    autoReviewTimers.delete(id)
    const nodes = props.vueCanvas?.getNodes?.() ?? []
    const edges = props.vueCanvas?.getEdges?.() ?? []
    if (!paidProducerFor(id, nodes, edges)) return
    reviewedTakes.set(id, String(takeId))
    autoReviewNode(id, props.vueCanvas?.agentNodeIntent?.(id) ?? '')
  }, 3000))
}
onMounted(() => {
  window.addEventListener('sailor:agentRunComplete', onRunComplete)
  window.addEventListener('sailor:critiqueNode', onCritiqueNode)
  window.addEventListener('sailor:autoReview', onAutoReview)
})
onBeforeUnmount(() => {
  window.removeEventListener('sailor:agentRunComplete', onRunComplete)
  window.removeEventListener('sailor:critiqueNode', onCritiqueNode)
  window.removeEventListener('sailor:autoReview', onAutoReview)
  for (const t of autoReviewTimers.values()) clearTimeout(t)
  if (warmFocusTimer) clearTimeout(warmFocusTimer)
})

// Drive the dot-grid "thinking" animation off the agent's busy state. (The white
// "analyzing" scan is rendered per-node, driven by useAgentActivity.analyzingNodeIds
// which useCanvasAgent sets during a review.)
const { thinking } = useAgentActivity()
watch(busy, (v) => { thinking.value = v })
onBeforeUnmount(() => { thinking.value = false })

// Hovering a proposal row highlights the node/wire it refers to on the canvas.
watch(hovered, (i) => {
  if (typeof props.vueCanvas?.agentHighlight !== 'function') return
  props.vueCanvas.agentHighlight(i != null ? changes.value[i]?.command ?? null : null)
})

function go(text: string) {
  const p = text.trim()
  if (!p || busy.value) return
  lastSubmitted.value = p
  fastPathFired.value = false // clear the fast-path dedupe latch for this new submit
  // Fast-path (Task 7, spec §6 lever 1): a high-confidence image idea fires
  // the sketch pad IMMEDIATELY, without waiting for the LLM classifier. The
  // classifier still runs below (the sketchIdea handler consumes
  // fastPathFired so a classifier `sketch` for the same submit doesn't
  // double-dispatch).
  const graphEmpty = (props.vueCanvas?.getNodes?.() ?? []).length === 0
  if (ready.value && looksLikeImageIdea(p, graphEmpty)) {
    fastPathFired.value = true
    props.vueCanvas.startSketch?.(p)
  }
  ask(p)
}

// The one prompt's context (spec §2.1): the canvas selection names the chip and
// placeholder; suggestions follow what's selected (or an empty graph).
const selection = computed(() => (props.vueCanvas?.agentSelection ?? []) as PromptNode[])
const chipLabel = computed(() => selectionLabel(selection.value))
const suggestions = computed(() => canvasSuggestions(selection.value, (props.vueCanvas?.getNodes?.() ?? []).length === 0))
const workingLabel = computed(() => busy.value ? 'Planning the change…' : 'Looking at the result…')
// The result card rides above the prompt once there is something to show.
// While planning, SailorPrompt's own row shows the progress label and Stop.
const showCard = computed(() => !busy.value && (reviewing.value || hasProposal.value || !!answer.value || !!error.value))
const promptRef = ref<InstanceType<typeof SailorPrompt> | null>(null)
defineExpose({ focus: () => promptRef.value?.focus() })

// Misfire correction handler.
// "…or sketch it?": hand the last submitted text straight to the sketch pad
// and drop the (mis-proposed) edit.
function sketchInstead() {
  if (ready.value && lastSubmitted.value) props.vueCanvas.startSketch?.(lastSubmitted.value)
  dismiss()
}

// Speculative warm (Task 7, spec §6 lever 2): on prompt-bar focus, ask the
// canvas to warm the Replicate flux-schnell endpoint with a throwaway
// single-output dispatch, so a real sketch submit right after doesn't eat a
// cold boot. Debounced (focus can fire repeatedly on tab/click churn) —
// VueNodeCanvas.warmSketch also self-gates on a 3-min cooldown.
// OFF BY DEFAULT: this spends a small real amount per warm
// (~$0.003), so it only fires when the user has opted in via this local
// setting (Settings has no toggle for it yet — set it from devtools:
// `localStorage.setItem('sailor:Sailor.Sketch.WarmEnabled', 'true')`).
const WARM_SETTING_KEY = 'Sailor.Sketch.WarmEnabled'
let warmFocusTimer: ReturnType<typeof setTimeout> | null = null
function onPromptFocus() {
  if (getLocalSetting(WARM_SETTING_KEY) !== 'true') return
  if (warmFocusTimer) clearTimeout(warmFocusTimer)
  warmFocusTimer = setTimeout(() => { props.vueCanvas?.warmSketch?.() }, 400)
}
</script>

<template>
  <!-- pointer-events: the ROOT is click-through and each interactive child
       re-enables events. The bar overlays the canvas (bottom-centre stack in
       default.vue), so any non-interactive chrome — the AI-setup notice, gaps —
       must not swallow canvas gestures underneath (e.g. wiring from a node
       handle that Fit View parked behind the bar). -->
  <div v-if="ready" class="pointer-events-none flex flex-col gap-2">
    <!-- (Teleports to body — unaffected by the root's pointer-events-none.) -->
    <ImageSearchPickerModal :open="searchOpen" :query="searchQuery" @close="searchOpen = false" @done="onSearchDone" />
    <SailorPrompt
      ref="promptRef"
      :selection-label="chipLabel"
      :suggestions="suggestions"
      :working="busy || reviewing"
      :working-label="workingLabel"
      :stoppable="busy"
      :disabled="!aiAvailable"
      @submit="go"
      @stop="stop"
      @clear-selection="props.vueCanvas?.agentClearSelection?.()"
      @focus="onPromptFocus"
    >
      <!-- Results expand upward, above the input (SailorPrompt owns the card chrome). -->
      <template v-if="showCard" #above>
        <!-- Dismiss the card for the answer / error states (no proposal → no
             keep/revert controls, so this is the only way to close it). -->
        <button
          v-if="!busy && !reviewing && !hasProposal && (answer || error)"
          class="absolute right-2 top-2 z-20 grid size-6 place-items-center rounded-md text-white/40 transition hover:bg-white/10 hover:text-white/80"
          title="Dismiss" @click="dismiss"
        ><X class="size-3.5" /></button>
        <p v-if="error" class="pr-6 text-[12px] leading-snug text-red-400/90">{{ error }}</p>
        <div v-else-if="answer" class="pr-6">
          <p v-if="reasoning" class="mb-1 text-[11px] leading-snug text-white/40">{{ reasoning }}</p>
          <p class="whitespace-pre-line text-[12.5px] leading-relaxed text-white/85">{{ answer }}</p>
        </div>
        <!-- Run→look→fix: looking at the result before any fixes are surfaced. -->
        <div v-if="reviewing && !hasProposal" class="flex items-center gap-1.5 text-[11.5px] text-white/55">
          <span class="text-white/75">✦</span> Analyzing the result for imperfections<span class="animate-pulse">…</span>
        </div>
        <AgentProposal
          v-if="hasProposal"
          :changes="changes" :busy="busy" :issues="issues" :review="review" :reviewing="reviewing" runnable
          @accept="acceptChange" @reject="rejectChange" @reroll="reroll"
          @keep="keep" @keep-run="keepAndRun" @revert="dismiss" @hover="(i: number | null) => hovered = i"
        />
      </template>
    </SailorPrompt>

    <!-- Misfire correction chip — auto-detect guessed the wrong intent.
         Dashed NEUTRAL affordance (draft/sketch token; never pastel — pastel
         reads as AI-generated here). -->
    <div v-if="hasProposal && lastSubmitted" class="pointer-events-auto flex flex-wrap gap-1.5 px-1">
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
