<script setup lang="ts">
// "When the frame resizes" — the per-layer pins card. Reads effective pins
// (stored where present, inferred where absent) and emits a patch back to the
// modal, which writes the stored `pins`. A control set back to its automatic
// value is cleared by the modal's cleanPins, so "Back to automatic" truly resets.
import StudioSection from './StudioSection.vue'
import StudioSelect from './studio/StudioSelect.vue'
import StudioSwitch from './studio/StudioSwitch.vue'
import type { EffectivePins, Pins } from '~/lib/frame/responsive'

const props = defineProps<{ pins: EffectivePins }>()
const emit = defineEmits<{ (e: 'patch', patch: Partial<Pins>): void; (e: 'auto'): void }>()

const H_VALUES = ['left', 'right', 'both', 'center', 'relative']
const H_LABELS = ['Left', 'Right', 'Left and right', 'Center', 'Keep relative position']
const V_VALUES = ['top', 'bottom', 'both', 'middle', 'relative']
const V_LABELS = ['Top', 'Bottom', 'Top and bottom', 'Middle', 'Keep relative position']

// Every axis inferred (nothing stored) => the whole card is running on automatic.
const anyAuto = () => props.pins.hAuto && props.pins.vAuto && props.pins.keepAuto && props.pins.holdAuto
</script>

<template>
  <StudioSection title="When the frame resizes">
    <div class="flex items-center gap-2 mb-2">
      <span v-if="anyAuto()" class="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/60">Automatic</span>
      <a v-else href="#" class="text-[11px] text-[#3b82f6] ml-auto" @click.prevent="emit('auto')">Back to automatic</a>
    </div>
    <StudioSelect label="Horizontal" :options="H_VALUES" :option-labels="H_LABELS"
      :model-value="pins.h" @update:model-value="(v: string) => emit('patch', { h: v as any })" />
    <StudioSelect label="Vertical" :options="V_VALUES" :option-labels="V_LABELS"
      :model-value="pins.v" @update:model-value="(v: string) => emit('patch', { v: v as any })" />
    <StudioSwitch label="Keep size" :model-value="pins.keepSize"
      @update:model-value="(v: boolean) => emit('patch', { keepSize: v })" />
    <StudioSelect v-if="pins.sectionAvailable" label="Holds to"
      :options="['section', 'frame']" :option-labels="['Section', 'Whole frame']"
      :model-value="pins.holdTo" @update:model-value="(v: string) => emit('patch', v === 'frame' ? { holdTo: 'frame' } : { holdTo: undefined } as any)" />
  </StudioSection>
</template>
