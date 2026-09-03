<script setup lang="ts">
/**
 * Card body for a Vector Type `kind: 'preset'` move — the tunable `params` a
 * kinetic-engine preset declares (Slide has distance, Glitch has intensity…).
 * An AXIS preset (`vtAxisPreset` knows the id) has no tunable params at all,
 * so the card says so rather than showing an empty list.
 *
 * Mounted by `~/lib/vectortype/movesAdapter.ts`'s `KINDS.preset.cardBody`,
 * driven by `MoveCard.vue`'s generic `<component :is="cardBody" :move :cfg
 * @patch>` contract — same param table (`KINETIC_PRESETS_BY_ID[id].params` /
 * `presetParamDefault`) the old Presets section read, just re-homed onto the
 * move's card instead of a picked slot.
 */
import { computed } from 'vue'
import { KINETIC_PRESETS_BY_ID, presetParamDefault } from '~/data/kinetic-presets'
import type { Move } from '~/lib/studio/moves/types'

const props = defineProps<{ move: Move; cfg: unknown }>()
const emit = defineEmits<{ (e: 'patch', partial: Partial<Move>): void }>()

const paramSpecs = computed(() => KINETIC_PRESETS_BY_ID[props.move.presetId ?? '']?.params ?? [])

function valueFor(key: string): number {
  return props.move.params?.[key] ?? presetParamDefault(props.move.presetId ?? '', key)
}
function setParam(key: string, raw: string) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  emit('patch', { params: { ...(props.move.params ?? {}), [key]: n } })
}
</script>

<template>
  <div v-if="!paramSpecs.length" class="text-[11px] text-white/35">
    No tunable parameters for this preset.
  </div>
  <div v-else class="flex flex-col gap-1.5">
    <label v-for="ps in paramSpecs" :key="ps.key" class="flex items-center gap-2 text-[11px] text-white/60">
      <span class="w-16 shrink-0 truncate">{{ ps.label }}</span>
      <input
        type="range" :min="ps.min" :max="ps.max" :step="ps.step" :value="valueFor(ps.key)"
        class="studio-range flex-1"
        @input="setParam(ps.key, ($event.target as HTMLInputElement).value)"
      />
      <span class="w-9 shrink-0 text-right tabular-nums text-white/70">{{ valueFor(ps.key) }}</span>
    </label>
  </div>
</template>
