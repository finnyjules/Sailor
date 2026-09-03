<script setup lang="ts">
/**
 * Vector Type's `MovesAdapter.clipExtras` — Letter by letter (stagger), the
 * one Motion control that stays outside the move list (design spec
 * `2026-09-03-vector-type-motion-moves-design.md`: "the Motion group keeps
 * only the stagger controls (they draw in the clip block)").
 *
 * Mounted by `MovesPanel.vue`'s Clip section: `<component :is="adapter
 * .clipExtras" :cfg="cfg" @patch="...">`. Reads `cfg.motion.stagger`
 * directly and emits `patch-cfg`-shaped partials (`MovesPanel` calls this
 * event `patch`, forwarded verbatim as its own `patch-cfg`), the same
 * contract a `MoveKindDef.cardBody` uses — see `~/lib/studio/moves/adapter
 * .ts`'s `clipExtras` doc.
 *
 * NOT built through `controls.ts`/`StudioControlPanel`: a `clipExtras`
 * component only ever receives `{ cfg }`, so there is no `setControl`/
 * `paramsProxy` to bind rows to here — same reasoning as the blink/scatter
 * card bodies.
 */
import { computed } from 'vue'
import { VT_STAGGER_DELAY_MAX, VT_STAGGER_ORDERS, VT_STAGGER_SEED_MAX, DEFAULT_CONFIG, type VectorTypeConfig } from '~/lib/vectortype/config'

const props = defineProps<{ cfg: VectorTypeConfig }>()
const emit = defineEmits<{ (e: 'patch', partial: Record<string, unknown>): void }>()

const stagger = computed(() => props.cfg?.motion?.stagger ?? DEFAULT_CONFIG.motion.stagger)

function patch(field: string, value: number | string) {
  emit('patch', { motion: { stagger: { [field]: value } } })
}
function setNum(field: string, raw: string) {
  const n = Number(raw)
  if (Number.isFinite(n)) patch(field, n)
}
</script>

<template>
  <div class="flex flex-col gap-1.5 border-t border-white/[0.06] pt-2.5">
    <p class="text-[10px] leading-snug text-white/30">
      Letter by letter — shifts the clock each glyph reads its moves at. Raise it and any moving axis becomes a wave travelling across the word.
    </p>
    <label class="flex items-center gap-2 text-[11px] text-white/60">
      <span class="w-16 shrink-0">Stagger</span>
      <input
        type="range" min="0" :max="VT_STAGGER_DELAY_MAX" step="0.01" :value="stagger.delay"
        class="studio-range flex-1"
        @input="setNum('delay', ($event.target as HTMLInputElement).value)"
      />
      <span class="w-9 shrink-0 text-right tabular-nums text-white/70">{{ stagger.delay.toFixed(2) }}</span>
    </label>
    <label class="flex items-center gap-2 text-[11px] text-white/60">
      <span class="w-16 shrink-0">Order</span>
      <select
        :value="stagger.order"
        class="flex-1 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-white/85 outline-none"
        @change="patch('order', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="o in VT_STAGGER_ORDERS" :key="o" :value="o">{{ o }}</option>
      </select>
    </label>
    <label v-if="stagger.order === 'random'" class="flex items-center gap-2 text-[11px] text-white/60">
      <span class="w-16 shrink-0">Shuffle seed</span>
      <input
        type="range" min="0" :max="VT_STAGGER_SEED_MAX" step="1" :value="stagger.seed"
        class="studio-range flex-1"
        @input="setNum('seed', ($event.target as HTMLInputElement).value)"
      />
      <span class="w-9 shrink-0 text-right tabular-nums text-white/70">{{ stagger.seed }}</span>
    </label>
  </div>
</template>
