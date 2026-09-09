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
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import { VT_BLINK_RATE_MAX, VT_BLINK_SEED_MAX, VT_BLINK_UNITS, DEFAULT_BLINK, type VtBlinkUnit } from '~/lib/vectortype/blink'
import type { Move } from '~/lib/studio/moves/types'
import type { VectorTypeConfig } from '~/lib/vectortype/config'

const props = defineProps<{ move: Move; cfg: VectorTypeConfig }>()
const emit = defineEmits<{ (e: 'patch-cfg', partial: Record<string, unknown>): void }>()

const blink = computed(() => props.cfg?.motion?.blink ?? DEFAULT_BLINK)

function patch(field: string, value: number | string) {
  emit('patch-cfg', { motion: { blink: { [field]: value } } })
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <StudioSlider
      :model-value="blink.amount" @update:model-value="(v) => patch('amount', v)"
      label="Amount" :min="0" :max="1" :step="0.05" :bindable="false"
    />
    <StudioSlider
      :model-value="blink.rate" @update:model-value="(v) => patch('rate', v)"
      label="Rate" :min="0" :max="VT_BLINK_RATE_MAX" :step="0.5" :bindable="false"
    />
    <StudioSlider
      :model-value="blink.stayLit" @update:model-value="(v) => patch('stayLit', v)"
      label="Stay lit" :min="0" :max="1" :step="0.05" :bindable="false"
    />
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
    <StudioSlider
      :model-value="blink.seed" @update:model-value="(v) => patch('seed', v)"
      label="Seed" :min="0" :max="VT_BLINK_SEED_MAX" :step="1" :bindable="false"
    />
  </div>
</template>
