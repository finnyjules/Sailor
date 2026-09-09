<script setup lang="ts">
/**
 * Card body for Vector Type's Scatter marker move (`kind: 'scatter'`, id
 * `__scatter` — `~/lib/vectortype/movesAdapter.ts`'s `derivedMoves`).
 *
 * Same reasoning as `VtBlinkCardBody.vue`: Scatter's settings live at
 * `cfg.motion.scatter`, its evaluator (`~/lib/vectortype/scatter.ts`) reads
 * them directly, and this body only ever emits `patch-cfg`.
 *
 * The axis field is a plain text input rather than a `<select>` of the
 * loaded font's declared tags (what `controls.ts`'s `derivedScatterControls`
 * offers) — a card body only receives `{ move, cfg }`, never the loaded
 * font's axis list, so there is no way to know which tags are real from
 * here. A free-text OpenType tag is still safe: `./scatter.ts`'s own
 * contract is that an unknown tag is IGNORED, never applied wrongly, and
 * `VectorTypeSurface.vue`'s Design → Axes section is where a user discovers
 * what this font actually declares.
 */
import { computed } from 'vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import {
  VT_SCATTER_MODES,
  VT_SCATTER_RATE_MAX,
  VT_SCATTER_SEED_MAX,
  VT_SCATTER_SETTLE_MAX,
  DEFAULT_SCATTER,
  type VtScatterMode,
} from '~/lib/vectortype/scatter'
import type { Move } from '~/lib/studio/moves/types'
import type { VectorTypeConfig } from '~/lib/vectortype/config'

const props = defineProps<{ move: Move; cfg: VectorTypeConfig }>()
const emit = defineEmits<{ (e: 'patch-cfg', partial: Record<string, unknown>): void }>()

const scatter = computed(() => props.cfg?.motion?.scatter ?? DEFAULT_SCATTER)

function patch(field: string, value: number | string) {
  emit('patch-cfg', { motion: { scatter: { [field]: value } } })
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <StudioSlider
      :model-value="scatter.spread" @update:model-value="(v) => patch('spread', v)"
      label="Spread" :min="0" :max="1" :step="0.05" :bindable="false"
    />
    <label class="flex items-center gap-2 text-[11px] text-white/60">
      <span class="w-16 shrink-0">Axis</span>
      <input
        type="text" maxlength="4" :value="scatter.axis"
        class="w-16 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-white/85 outline-none"
        @change="patch('axis', ($event.target as HTMLInputElement).value.trim())"
      />
      <span class="text-[10px] text-white/30">OpenType tag, e.g. wght</span>
    </label>
    <label class="flex items-center gap-2 text-[11px] text-white/60">
      <span class="w-16 shrink-0">Mode</span>
      <select
        :value="scatter.mode"
        class="flex-1 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-white/85 outline-none"
        @change="patch('mode', ($event.target as HTMLSelectElement).value as VtScatterMode)"
      >
        <option v-for="m in VT_SCATTER_MODES" :key="m" :value="m">{{ m }}</option>
      </select>
    </label>
    <StudioSlider
      v-if="scatter.mode === 'settle'"
      :model-value="scatter.settle" @update:model-value="(v) => patch('settle', v)"
      label="Settle time" :min="0" :max="VT_SCATTER_SETTLE_MAX" :step="0.05" :bindable="false"
    />
    <StudioSlider
      v-else
      :model-value="scatter.rate" @update:model-value="(v) => patch('rate', v)"
      label="Drift rate" :min="0" :max="VT_SCATTER_RATE_MAX" :step="0.05" :bindable="false"
    />
    <StudioSlider
      :model-value="scatter.seed" @update:model-value="(v) => patch('seed', v)"
      label="Seed" :min="0" :max="VT_SCATTER_SEED_MAX" :step="1" :bindable="false"
    />
  </div>
</template>
