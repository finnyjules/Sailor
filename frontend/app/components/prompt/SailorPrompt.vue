<script setup lang="ts">
// The one prompt (spec §2.1a). Identical everywhere; hosts supply only context
// (selection label, mode, suggestions, working state) and put result cards in
// the `above` slot. Never restyle this from a host — change it here.
import { computed, ref } from 'vue'
import { ArrowUp, X } from 'lucide-vue-next'
import AiMark from '~/components/prompt/AiMark.vue'
import AgentSweep from '~/components/agent/AgentSweep.vue'
import { escapeStep, promptPlaceholder } from '~/lib/prompt/sailorPrompt'

const props = withDefaults(defineProps<{
  selectionLabel?: string | null
  mode?: string | null
  suggestions?: string[]
  working?: boolean
  workingLabel?: string
  stoppable?: boolean
  disabled?: boolean
}>(), { selectionLabel: null, mode: null, suggestions: () => [], working: false, workingLabel: 'Working…', stoppable: true, disabled: false })

const emit = defineEmits<{ submit: [text: string]; stop: []; clearSelection: []; clearMode: []; focus: []; blur: [] }>()

const text = ref('')
const focused = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)
const placeholder = computed(() => promptPlaceholder(props.selectionLabel))
const showSuggestions = computed(() => focused.value && !props.working && props.suggestions.length > 0)

function submit(value = text.value) {
  const t = value.trim()
  if (!t || props.working || props.disabled) return
  emit('submit', t)
  text.value = ''
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); submit(); return }
  if (e.key === 'Escape') {
    e.preventDefault()
    if (escapeStep({ text: text.value, mode: props.mode }) === 'clearMode') emit('clearMode')
    else { focused.value = false; emit('blur'); inputEl.value?.blur() }
  }
}
function onFocus() { focused.value = true; emit('focus') }
function onBlur() { if (!focused.value) return; focused.value = false; emit('blur') } // Esc already emitted when it set focused=false
function focus() { inputEl.value?.focus() }
// The text field itself, for hosts that must know whether it can take focus
// (null while working — the row shows the progress label instead).
function inputElement(): HTMLInputElement | null { return inputEl.value }
defineExpose({ focus, inputElement })
</script>

<template>
  <div class="sailor-prompt pointer-events-none flex w-full min-w-0 flex-col gap-2">
    <div v-if="showSuggestions" data-testid="prompt-suggestions" class="pointer-events-auto flex flex-wrap justify-center gap-1.5">
      <button
        v-for="s in suggestions" :key="s" type="button"
        class="rounded-full border border-[#2a2a2a] bg-[#1e1f23] px-3 py-1 text-[12px] text-white/75 shadow-md transition hover:border-white/30 hover:text-white"
        @mousedown.prevent="submit(s)"
      >{{ s }}</button>
    </div>

    <div v-if="$slots.above" data-testid="prompt-card" class="pointer-events-auto relative max-h-[52vh] overflow-y-auto rounded-[12px] border border-[#2a2a2a] bg-[#1a1a1a]/95 p-3 shadow-xl backdrop-blur-md">
      <slot name="above" />
    </div>

    <div
      class="sp-row pointer-events-auto relative flex h-12 items-center gap-2.5 overflow-hidden rounded-[12px] pl-3.5 pr-2.5 shadow-lg"
      :class="{ 'is-active': focused || working }"
      @click="focus"
    >
      <!-- Always mounted: AgentSweep's watcher runs immediately at setup, before its
           canvas exists, so mounting it already-active (v-if) never starts the glimm.
           It hides its own canvas while inactive. -->
      <div class="pointer-events-none absolute inset-0"><AgentSweep :active="working" :period="3" palette="lagoon" /></div>
      <AiMark kind="star" class="relative size-4 shrink-0" />
      <template v-if="working">
        <span class="relative min-w-0 flex-1 truncate text-[13px] text-white/75">{{ workingLabel }}</span>
        <button
          v-if="stoppable" data-testid="prompt-stop" type="button"
          class="relative rounded-md border border-[#2a2a2a] bg-[#1e1f23] px-2.5 py-0.5 text-[12px] text-white/80 hover:text-white"
          @click.stop="emit('stop')"
        >Stop</button>
      </template>
      <template v-else>
        <span v-if="mode" data-testid="prompt-mode-chip" class="relative inline-flex max-w-[40%] shrink-0 items-center truncate rounded-full bg-white/[0.08] py-0.5 pl-2.5 pr-1 text-[12px] text-white/80">
          {{ mode }}<button type="button" class="px-1 text-white/50 hover:text-white" aria-label="Clear mode" @click.stop="emit('clearMode')"><X class="size-3" /></button>
        </span>
        <span v-if="selectionLabel" data-testid="prompt-selection-chip" class="relative inline-flex max-w-[40%] shrink-0 items-center truncate rounded-full bg-white/[0.08] py-0.5 pl-2.5 pr-1 text-[12px] text-white/80">
          {{ selectionLabel }}<button type="button" class="px-1 text-white/50 hover:text-white" aria-label="Clear selection" @click.stop="emit('clearSelection')"><X class="size-3" /></button>
        </span>
        <input
          ref="inputEl" v-model="text" type="text" aria-label="Ask Sailor"
          :placeholder="placeholder" :disabled="disabled"
          class="relative min-w-0 flex-1 bg-transparent text-[13px] text-white/90 outline-none placeholder:text-white/30"
          @keydown="onKeydown" @focus="onFocus" @blur="onBlur"
        >
        <kbd v-if="!focused" class="relative rounded border border-white/10 px-1.5 font-mono text-[11px] text-white/35">/</kbd>
        <button
          type="button" aria-label="Send"
          class="relative grid size-7 place-items-center rounded-[8px] bg-white text-neutral-900 transition hover:bg-white/90 disabled:opacity-40"
          :disabled="disabled || !text.trim()" @click.stop="submit()"
        ><ArrowUp class="size-4" /></button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sp-row { background: #1a1a1a; }
/* The pastel ring (same primitive as the canvas prompt and proposed nodes):
   a masked conic on the global --pastel-angle, faint at rest, full when active. */
.sp-row::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: conic-gradient(from var(--pastel-angle), #ffd6e7, #cfe8ff, #d6ffe0, #fff4cc, #e7d6ff, #ffd6e7);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  opacity: 0.4;
  transition: opacity 0.4s ease;
  animation: pastel-spin 8s linear infinite;
  pointer-events: none;
  z-index: 1;
}
.sp-row.is-active::before { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .sp-row::before { animation: none; } }
</style>
