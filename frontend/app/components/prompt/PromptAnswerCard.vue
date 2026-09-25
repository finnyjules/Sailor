<script setup lang="ts">
// Words about the work (spec §3.3): "✦ Answer", the text, and follow-up chips
// that run as normal requests. A notice (a kind with no worker here yet) has no
// heading; an error reads red. Follow-ups are neutral, not pastel.
import { X } from 'lucide-vue-next'
import AiMark from '~/components/prompt/AiMark.vue'

defineProps<{ card: { kind: 'answer' | 'notice' | 'error'; text: string; reasoning: string; followUps: string[] } }>()
const emit = defineEmits<{ close: []; followUp: [text: string] }>()
</script>

<template>
  <div data-testid="prompt-answer" class="relative grid grid-cols-1 gap-2 pr-7">
    <button
      type="button" aria-label="Close"
      class="absolute -right-1 -top-1 grid size-6 place-items-center rounded-md text-white/40 transition hover:bg-white/10 hover:text-white/80"
      @click="emit('close')"
    ><X class="size-3.5" /></button>
    <div v-if="card.kind === 'answer'" class="flex items-center gap-1.5 text-[12px] text-white/70">
      <AiMark kind="star" class="size-3.5" /><span>Answer</span>
    </div>
    <p v-if="card.kind === 'error'" class="text-[12px] leading-snug text-red-400/90">{{ card.text }}</p>
    <template v-else>
      <p v-if="card.reasoning" class="text-[11px] leading-snug text-white/40">{{ card.reasoning }}</p>
      <p class="whitespace-pre-line text-[13px] leading-relaxed text-white/85">{{ card.text }}</p>
    </template>
    <div v-if="card.followUps.length" class="flex flex-wrap gap-1.5">
      <button
        v-for="f in card.followUps" :key="f" type="button"
        class="rounded-full border border-[#2a2a2a] bg-[#1e1f23] px-3 py-1 text-[12px] text-white/75 transition hover:border-white/30 hover:text-white"
        @click="emit('followUp', f)"
      >{{ f }}</button>
    </div>
  </div>
</template>
