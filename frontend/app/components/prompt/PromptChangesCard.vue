<script setup lang="ts">
// A proposed change to the graph (spec §3.2). The nodes themselves show on the
// canvas as "Proposed" ghosts; this card lists the change and approves it.
// Hovering a row points at its node or wire on the canvas.
import { computed } from 'vue'
import { Check, Dices, X } from 'lucide-vue-next'
import AiMark from '~/components/prompt/AiMark.vue'
import { changeLines, changesTitle } from '~/lib/prompt/changeLines'
import type { ProposedChange, VisualReview } from '~/composables/useLayoutAgent'
import type { LayoutIssue } from '~/lib/agent/verify'

const props = defineProps<{ changes: ProposedChange[]; busy: boolean; issues?: LayoutIssue[]; review?: VisualReview | null; reviewing?: boolean; runnable?: boolean }>()
const emit = defineEmits<{ accept: [i: number]; reject: [i: number]; reroll: [i: number]; approve: []; approveRun: []; rejectAll: []; hover: [i: number | null] }>()
const lines = computed(() => changeLines(props.changes))
const title = computed(() => changesTitle(props.changes))
</script>

<template>
  <div data-testid="prompt-changes" class="grid grid-cols-1 gap-2.5">
    <div class="flex items-center gap-1.5 text-[12.5px] text-white/80">
      <AiMark kind="star" class="size-3.5 shrink-0" /><span>{{ title }}</span>
    </div>

    <p v-for="(iss, k) in issues ?? []" :key="`i${k}`" class="flex items-start gap-1.5 text-[11px] leading-snug text-amber-300/80">
      <span class="shrink-0">⚠</span><span>{{ iss.message }}</span>
    </p>

    <ul class="grid grid-cols-1 gap-1">
      <li
        v-for="l in lines" :key="l.index" data-testid="prompt-change-row"
        class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition hover:bg-white/[0.05]"
        @mouseenter="emit('hover', l.index)" @mouseleave="emit('hover', null)"
      >
        <b class="w-3 shrink-0 text-center font-mono text-white/55">{{ l.mark }}</b>
        <span class="min-w-0 flex-1 truncate" :class="l.accepted ? 'text-white/90' : 'text-white/35 line-through'">{{ l.text }}</span>
        <span v-if="l.fromReview" class="shrink-0 rounded-full bg-white/[0.08] px-1.5 py-px text-[10px] text-white/60">from the review</span>
        <button v-if="l.rerollable" type="button" class="action" :disabled="busy" aria-label="Try another value" @click="emit('reroll', l.index)"><Dices class="size-3.5" /></button>
        <button
          v-if="l.accepted" type="button" class="action text-emerald-300" aria-label="Leave this change out" @click="emit('reject', l.index)"
        ><Check class="size-3.5" /></button>
        <button v-else type="button" class="action" aria-label="Include this change" @click="emit('accept', l.index)"><X class="size-3.5" /></button>
      </li>
    </ul>

    <div v-if="reviewing" class="flex items-center gap-1.5 text-[11px] text-white/45">
      <AiMark kind="star" class="size-3" /> Reviewing the result<span class="animate-pulse">…</span>
    </div>
    <div v-else-if="review && (review.assessment || review.issues.length)" class="grid gap-1">
      <p v-if="review.assessment" class="text-[11.5px] leading-snug text-white/60">{{ review.assessment }}</p>
      <p v-for="(iss, k) in review.issues" :key="`r${k}`" class="flex items-start gap-1.5 text-[11px] leading-snug text-amber-300/80">
        <span class="shrink-0">⚠</span><span>{{ iss }}</span>
      </p>
    </div>

    <div class="flex items-center justify-end gap-2 pt-1">
      <button type="button" :disabled="busy" class="rounded-md px-3 py-1 text-[12px] text-white/60 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40" @click="emit('rejectAll')">Reject</button>
      <button v-if="runnable" type="button" :disabled="busy" class="rounded-md border border-[#2a2a2a] bg-[#1e1f23] px-3 py-1 text-[12px] text-white/80 transition hover:text-white disabled:opacity-40" @click="emit('approveRun')">Approve and run</button>
      <button type="button" :disabled="busy" class="rounded-md bg-white px-3 py-1 text-[12px] font-medium text-neutral-900 transition hover:bg-white/90 disabled:opacity-40" @click="emit('approve')">Approve</button>
    </div>
  </div>
</template>

<style scoped>
.action { display: grid; width: 24px; height: 24px; flex-shrink: 0; place-items: center; border-radius: 6px; color: rgba(255, 255, 255, 0.5); transition: background 0.15s ease, color 0.15s ease; }
.action:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
.action:disabled { opacity: 0.4; }
</style>
