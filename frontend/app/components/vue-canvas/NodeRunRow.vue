<script setup lang="ts">
// The slim Run row (spec §2.3): one 28px line in the node's own DOM, so it
// zooms with the node. Status dot + text on the left; ▶ and an optional caret
// menu (slot `menu`) on the right. The status comes from runRowStatus().
import { useId } from 'vue'
import { Play, Loader2 } from 'lucide-vue-next'
import type { RunTone } from '~/lib/canvas/runRowStatus'

const props = withDefaults(defineProps<{
  status: { tone: RunTone; text: string }
  canRun: boolean
  running: boolean
  runLabel?: string
  variant?: 'slim' | 'instrument'
  price?: string | null
  /** The price's tooltip (R7 ruling (b): which service runs the node, "Runs on Replicate"). */
  priceTitle?: string | null
  buttonText?: string
  /**
   * Why the node can't run at all (a retired node, R4.1 fix round 1): the
   * button stays focusable but inert (aria-disabled), with the reason as its
   * tooltip and its accessible description.
   */
  blockedReason?: string | null
}>(), { runLabel: 'Run this node', variant: 'slim', price: null, priceTitle: null, buttonText: 'Run', blockedReason: null })

const reasonId = `run-blocked-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

const emit = defineEmits<{ run: [] }>()

const DOT: Record<RunTone, string> = {
  idle: 'bg-white/30',
  running: 'bg-white animate-pulse',
  done: 'bg-[#7fbf8a]',
  error: 'bg-red-400',
  live: 'bg-sky-400',
}

function onRun() {
  if (props.running || !props.canRun) return
  emit('run')
}
</script>

<template>
  <div
    v-if="variant === 'slim'"
    class="node-run-row relative flex items-center gap-2 h-7 px-2.5 border-t border-white/[0.06]"
    :data-tone="status.tone"
  >
    <span class="shrink-0 size-1.5 rounded-full" :class="DOT[status.tone]" aria-hidden="true" />
    <span class="flex-1 min-w-0 truncate text-[11px] text-white/60" :title="status.text">{{ status.text }}</span>
    <button
      type="button"
      class="nopan nodrag shrink-0 size-5 rounded-[5px] flex items-center justify-center text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      :aria-label="runLabel"
      :title="blockedReason || runLabel"
      :disabled="(running || !canRun) && !blockedReason"
      :aria-disabled="blockedReason ? 'true' : undefined"
      :aria-describedby="blockedReason ? reasonId : undefined"
      :class="{ 'opacity-40 cursor-not-allowed': blockedReason }"
      @click.stop="onRun"
    >
      <Loader2 v-if="running" class="size-3 animate-spin" />
      <Play v-else class="size-3" fill="currentColor" />
    </button>
    <span v-if="blockedReason" :id="reasonId" class="sr-only">{{ blockedReason }}</span>
    <slot name="menu" />
  </div>
  <div
    v-else
    class="node-shell__foot node-run-row node-run-row--instrument relative"
    :data-tone="status.tone"
  >
    <span class="shrink-0 size-1.5 rounded-full" :class="DOT[status.tone]" aria-hidden="true" />
    <span data-run-status class="flex-1 min-w-0 truncate text-[12px] text-white/55" :title="status.text">{{ status.text }}</span>
    <button
      type="button"
      class="nopan nodrag node-btn node-btn--primary disabled:opacity-40 disabled:cursor-not-allowed"
      :aria-label="runLabel"
      :title="blockedReason || runLabel"
      :disabled="(running || !canRun) && !blockedReason"
      :aria-disabled="blockedReason ? 'true' : undefined"
      :aria-describedby="blockedReason ? reasonId : undefined"
      :class="{ 'opacity-40 cursor-not-allowed': blockedReason }"
      @click.stop="onRun"
    >
      <Loader2 v-if="running" class="size-3 animate-spin" />
      <Play v-else class="size-2.5" fill="currentColor" />
      <span>{{ buttonText }}</span>
      <span v-if="price && !running" class="node-btn__price" :title="priceTitle ?? undefined">{{ price }}</span>
    </button>
    <span v-if="blockedReason" :id="reasonId" class="sr-only">{{ blockedReason }}</span>
    <slot name="menu" />
  </div>
</template>
