<script setup lang="ts">
/**
 * Status bar that sits at the top-center of the canvas while a workflow is
 * running, and briefly summarizes the last result after it finishes. Replaces
 * the "Workflow started" / "Workflow completed" / "Workflow failed" toasts —
 * one place to look at the state of the run instead of stacked floaters.
 *
 * States:
 *   - idle:    component renders nothing
 *   - running: spinner + node name + N/total + elapsed
 *   - success: green check + duration (auto-clears after a few seconds)
 *   - error:   red icon + node + message + dismiss (persists until cleared)
 */
import { CheckCircle2, Loader2, AlertCircle, X, Square } from 'lucide-vue-next'
import { fmtSec, elapsedSince } from '~/lib/canvas/elapsed'
import { inLineLabel } from '~/lib/canvas/capsuleReadout'
import { resolveCostDisplay } from '~/lib/canvas/runCostDisplay'
import { hostedModeEnabled } from '~/lib/hostedMode'

export type RunResult =
  // `cost` is the Comfy-credits delta (used for native nodes that hit Comfy's
  // billing). `usd` is the Replicate dollar estimate (used when the run hit
  // the user's own Replicate account — their balance, not Comfy's). The two
  // are mutually exclusive: a run is either Replicate-billed or Comfy-billed.
  // Both can be omitted when we couldn't determine cost (free, local, unknown).
  | {
      kind: 'success'; durationMs: number; at: number;
      cost?: number | null;
      usd?: number | null;
      usdApproximate?: boolean;
    }
  | { kind: 'error'; nodeName: string; message: string; at: number }

const props = defineProps<{
  running: boolean
  currentNode: string
  progress: { completed: number; total: number }
  percent: number
  startedAt: number | null
  queuePosition?: number | null
  lastResult: RunResult | null
  backendBusy?: boolean
  backendLabel?: string
  backendSuccess?: boolean
  backendSuccessLabel?: string
}>()

const emit = defineEmits<{
  stop: []
  dismissResult: []
}>()

// Tick once a second so the elapsed time stays live without the parent
// having to push updates.
const now = ref(Date.now())
let tickId: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  tickId = setInterval(() => { now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => {
  if (tickId) clearInterval(tickId)
})

const elapsedSec = computed(() => elapsedSince(props.startedAt, now.value))

// Hosted tenants are debited CREDITS via the ledger even for Replicate-billed
// nodes — lastResult.usd is a raw-dollar figure computed the same way local's
// is and does not reflect what a hosted user was actually charged, so hosted
// must never render it (see runCostDisplay.ts). Read the same way sibling
// components do (SelectionActionChips.vue, ComfyNode.vue, …) rather than
// prop-drilled from the parent.
const hosted = hostedModeEnabled(useRuntimeConfig().public)
const costDisplay = computed(() =>
  props.lastResult?.kind === 'success' ? resolveCostDisplay(props.lastResult, hosted) : null)

const view = computed<'backend' | 'backend-success' | 'running' | 'success' | 'error' | null>(() => {
  if (props.backendBusy) return 'backend'
  if (props.backendSuccess) return 'backend-success'
  if (props.running) return 'running'
  if (props.lastResult?.kind === 'error') return 'error'
  if (props.lastResult?.kind === 'success') return 'success'
  return null
})
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-200 ease-out"
    enter-from-class="opacity-0 -translate-y-1"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition-all duration-150 ease-in"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0 -translate-y-1"
  >
    <div
      v-if="view"
      class="absolute top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 max-w-[640px] px-3 py-1.5 rounded-full bg-[#1a1a1a]/95 backdrop-blur-sm border shadow-lg"
      :class="{
        'border-white/10': view === 'running' || view === 'backend',
        'border-emerald-500/30': view === 'success' || view === 'backend-success',
        'border-red-500/35': view === 'error',
      }"
    >
      <!-- Backend booting / reconnecting / loading -->
      <template v-if="view === 'backend'">
        <Loader2 class="size-3.5 shrink-0 animate-spin text-white/55" />
        <span class="text-[12px] text-white/85 truncate max-w-[320px]" :title="backendLabel">
          {{ backendLabel || 'Loading…' }}
        </span>
      </template>

      <!-- Backend ready: brief success flash before the pill clears. -->
      <template v-else-if="view === 'backend-success'">
        <CheckCircle2 class="size-3.5 shrink-0 text-emerald-400" />
        <span class="text-[12px] text-white/85">{{ backendSuccessLabel || 'Ready' }}</span>
      </template>

      <!-- Running -->
      <template v-else-if="view === 'running'">
        <Loader2 class="size-3.5 shrink-0 animate-spin text-palette-blue" />
        <span class="text-[12px] text-white/85 truncate max-w-[280px]" :title="currentNode">
          {{ queuePosition && queuePosition > 0 ? `${currentNode ? `${currentNode} · ` : ''}${inLineLabel(queuePosition)}` : (currentNode || 'Starting…') }}
        </span>
        <span v-if="progress.total > 0" class="text-[11px] text-white/45 tabular-nums shrink-0">
          {{ progress.completed }}/{{ progress.total }}
        </span>
        <span v-if="percent > 0 && percent < 100" class="text-[11px] text-white/40 tabular-nums shrink-0">
          {{ percent }}%
        </span>
        <span class="text-[11px] text-white/45 tabular-nums shrink-0">
          {{ fmtSec(elapsedSec) }}
        </span>
        <button
          class="ml-1 shrink-0 size-5 rounded-md flex items-center justify-center text-white/55 hover:text-palette-coral hover:bg-white/[0.08] transition-colors cursor-pointer"
          title="Stop"
          @click="emit('stop')"
        >
          <Square class="size-2.5" fill="currentColor" />
        </button>
      </template>

      <!-- Success -->
      <template v-else-if="view === 'success' && lastResult?.kind === 'success'">
        <CheckCircle2 class="size-3.5 shrink-0 text-emerald-400" />
        <span class="text-[12px] text-white/85">
          Done in {{ fmtSec(lastResult.durationMs / 1000) }}
        </span>
        <!-- Cost. Local prefers USD (Replicate BYOK) — the user's Replicate
             balance is dollar-based and doesn't move Comfy's credit balance.
             Hosted skips USD entirely (it's fiction there — hosted debits
             credits, not dollars, for the same nodes) and shows credits
             instead. Both hidden when zero/unknown so a run doesn't read
             like "free!" advertising. See runCostDisplay.ts. -->
        <span
          v-if="costDisplay?.kind === 'usd'"
          class="text-[11px] text-white/45 tabular-nums shrink-0"
        >
          · {{ costDisplay.approximate ? '~' : '' }}${{ costDisplay.value.toFixed(costDisplay.value >= 1 ? 2 : 3) }}
        </span>
        <span
          v-else-if="costDisplay?.kind === 'credits'"
          class="text-[11px] text-white/45 tabular-nums shrink-0"
        >
          · −{{ costDisplay.value.toLocaleString() }} credits
        </span>
      </template>

      <!-- Error -->
      <template v-else-if="view === 'error' && lastResult?.kind === 'error'">
        <AlertCircle class="size-3.5 shrink-0 text-red-400" />
        <span class="text-[12px] text-white/85 shrink-0">{{ lastResult.nodeName }} failed</span>
        <span
          class="text-[11px] text-red-200/85 truncate"
          :title="lastResult.message"
        >— {{ lastResult.message }}</span>
        <button
          class="ml-1 shrink-0 size-5 rounded-md flex items-center justify-center text-white/55 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
          title="Dismiss"
          @click="emit('dismissResult')"
        >
          <X class="size-3" />
        </button>
      </template>
    </div>
  </Transition>
</template>
