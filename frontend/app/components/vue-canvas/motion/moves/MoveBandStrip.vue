<script setup lang="ts">
/**
 * Read-only clip-shape strip: amber In / emerald Loop / amber Out, sized by
 * `bandSpans` (`~/lib/studio/moves/phase.ts` — the SAME fraction math the
 * band-strip spec elsewhere uses; colours match the existing
 * `Scene3DMotionTimeline.vue` convention: `bg-amber-400/70` /
 * `bg-emerald-400/60`). Unlike that timeline, this strip has no drag
 * handles — the moves list is where duration changes, this is just a
 * picture of the clip's shape.
 *
 * NOTHING here may import from `lib/vectortype`.
 */
import { computed } from 'vue'
import { bandSpans } from '~/lib/studio/moves/phase'
import type { Move } from '~/lib/studio/moves/types'

const props = defineProps<{ moves: Move[]; clip: number }>()

const hasMoves = computed(() => props.moves.length > 0)
const hasIn = computed(() => props.moves.some((m) => m.phase === 'in'))
const hasOut = computed(() => props.moves.some((m) => m.phase === 'out'))

const spans = computed(() => bandSpans(props.moves, props.clip))
const inSeconds = computed(() => spans.value.inFrac * props.clip)
const outSeconds = computed(() => spans.value.outFrac * props.clip)

const pct = (frac: number) => `${(frac * 100).toFixed(3)}%`
const fmtSeconds = (s: number) => `${s.toFixed(1)}s`
</script>

<template>
  <div v-if="hasMoves" class="flex flex-col gap-1">
    <div class="relative h-2.5 overflow-hidden rounded border border-white/10 bg-white/[0.03]">
      <div v-if="hasIn" class="absolute inset-y-0 left-0 bg-amber-400/70" :style="{ width: pct(spans.inFrac) }" />
      <div class="absolute inset-y-0 bg-emerald-400/60" :style="{ left: pct(spans.inFrac), width: pct(spans.loopFrac) }" />
      <div v-if="hasOut" class="absolute inset-y-0 right-0 bg-amber-400/70" :style="{ width: pct(spans.outFrac) }" />
    </div>
    <div class="grid grid-cols-3 text-[10px] text-white/40">
      <span class="text-left">{{ hasIn ? `In ${fmtSeconds(inSeconds)}` : '' }}</span>
      <span class="text-center">Loop</span>
      <span class="text-right">{{ hasOut ? `Out ${fmtSeconds(outSeconds)}` : '' }}</span>
    </div>
  </div>
</template>
