<script setup lang="ts">
/**
 * Card body for Vector Type's Blink marker move (`kind: 'blink'`, id
 * `__blink` — `~/lib/vectortype/movesAdapter.ts`'s `derivedMoves`).
 *
 * Blink is not a track and carries no config of its own on the MOVE — its
 * settings live at `cfg.motion.blink` and its evaluator (`~/lib/vectortype
 * /blink.ts`) reads them directly, unconditioned on this move even existing.
 * So this body never emits `patch` (there is nothing on the move worth
 * writing); every dial here emits `patch-cfg` instead, which `MoveCard.vue`
 * forwards up through `MovesPanel`'s `patch-cfg` to the surface, which
 * writes it into `config.value.motion.blink.*` the same way the OLD
 * `motion.blink.*` StudioControlPanel sliders did (`setControl`, so a bound
 * Collection column still writes through).
 *
 * Same five controls `controls.ts` declared for this group — amount, rate,
 * stay lit, unit, seed — read here directly off `cfg.motion.blink` rather
 * than through the schema/StudioControlPanel machinery, since a card body
 * only ever receives `{ move, cfg }`.
 */
import { computed } from 'vue'
import { VT_BLINK_RATE_MAX, VT_BLINK_SEED_MAX, VT_BLINK_UNITS, DEFAULT_BLINK, type VtBlinkUnit } from '~/lib/vectortype/blink'
import type { Move } from '~/lib/studio/moves/types'
import type { VectorTypeConfig } from '~/lib/vectortype/config'

const props = defineProps<{ move: Move; cfg: VectorTypeConfig }>()
const emit = defineEmits<{ (e: 'patch-cfg', partial: Record<string, unknown>): void }>()

const blink = computed(() => props.cfg?.motion?.blink ?? DEFAULT_BLINK)

function patch(field: string, value: number | string) {
  emit('patch-cfg', { motion: { blink: { [field]: value } } })
}
function setNum(field: string, raw: string) {
  const n = Number(raw)
  if (Number.isFinite(n)) patch(field, n)
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label class="flex items-center gap-2 text-[11px] text-white/60">
      <span class="w-16 shrink-0">Amount</span>
      <input
        type="range" min="0" max="1" step="0.05" :value="blink.amount"
        class="studio-range flex-1"
        @input="setNum('amount', ($event.target as HTMLInputElement).value)"
      />
      <span class="w-9 shrink-0 text-right tabular-nums text-white/70">{{ blink.amount.toFixed(2) }}</span>
    </label>
    <label class="flex items-center gap-2 text-[11px] text-white/60">
      <span class="w-16 shrink-0">Rate</span>
      <input
        type="range" min="0" :max="VT_BLINK_RATE_MAX" step="0.5" :value="blink.rate"
        class="studio-range flex-1"
        @input="setNum('rate', ($event.target as HTMLInputElement).value)"
      />
      <span class="w-9 shrink-0 text-right tabular-nums text-white/70">{{ blink.rate }}</span>
    </label>
    <label class="flex items-center gap-2 text-[11px] text-white/60">
      <span class="w-16 shrink-0">Stay lit</span>
      <input
        type="range" min="0" max="1" step="0.05" :value="blink.stayLit"
        class="studio-range flex-1"
        @input="setNum('stayLit', ($event.target as HTMLInputElement).value)"
      />
      <span class="w-9 shrink-0 text-right tabular-nums text-white/70">{{ blink.stayLit.toFixed(2) }}</span>
    </label>
    <label class="flex items-center gap-2 text-[11px] text-white/60">
      <span class="w-16 shrink-0">Unit</span>
      <select
        :value="blink.unit"
        class="flex-1 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-white/85 outline-none"
        @change="patch('unit', ($event.target as HTMLSelectElement).value as VtBlinkUnit)"
      >
        <option v-for="u in VT_BLINK_UNITS" :key="u" :value="u">{{ u }}</option>
      </select>
    </label>
    <label class="flex items-center gap-2 text-[11px] text-white/60">
      <span class="w-16 shrink-0">Seed</span>
      <input
        type="range" min="0" :max="VT_BLINK_SEED_MAX" step="1" :value="blink.seed"
        class="studio-range flex-1"
        @input="setNum('seed', ($event.target as HTMLInputElement).value)"
      />
      <span class="w-9 shrink-0 text-right tabular-nums text-white/70">{{ blink.seed }}</span>
    </label>
  </div>
</template>
