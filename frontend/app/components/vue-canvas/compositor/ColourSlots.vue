<!-- frontend/app/components/vue-canvas/compositor/ColourSlots.vue -->
<script setup lang="ts">
// The frame's colour slots as swatches (heaviest first). After a palette family
// has been applied, a swatch opens that family's colours so one slot can be sent
// elsewhere — a wrong mapping is one click, not a rebuild.
import { ref } from 'vue'
const props = withDefaults(defineProps<{ slots: { hex: string; weight: number }[]; family?: string[] | null }>(), { family: null })
const emit = defineEmits<{ (e: 'reassign', slotHex: string, toHex: string): void }>()
const open = ref<string | null>(null)
function toggle(hex: string) { if (!props.family) return; open.value = open.value === hex ? null : hex }
function pick(slotHex: string, toHex: string) { open.value = null; if (toHex !== slotHex) emit('reassign', slotHex, toHex) }
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap gap-1.5" aria-label="Frame colours">
      <button
        v-for="(s, i) in slots" :key="s.hex" type="button" data-testid="colour-slot" :data-hex="s.hex"
        :title="family ? `Colour ${s.hex} — send to another colour` : `Colour ${s.hex}`" :aria-label="`Colour ${s.hex}`"
        class="h-7 rounded-md ring-1 ring-white/15 transition-[box-shadow] hover:ring-white/50 focus-visible:ring-white"
        :class="[i === 0 ? 'w-14' : 'w-7', family ? 'cursor-pointer' : 'cursor-default', open === s.hex ? 'ring-2 ring-white' : '']"
        :style="{ background: s.hex }" :disabled="!family"
        @click="toggle(s.hex)"
      />
    </div>
    <div v-if="open && family" class="flex flex-wrap gap-1.5 rounded-lg bg-white/[0.04] p-2" data-testid="colour-slot-options">
      <span class="w-full text-[11px] text-white/45">Send this colour to</span>
      <button
        v-for="h in family" :key="h" type="button" data-testid="colour-slot-option" :data-hex="h" :title="h" :aria-label="`Use ${h}`"
        class="h-6 w-6 rounded ring-1 ring-white/15 hover:ring-white/60" :style="{ background: h }"
        @click="pick(open!, h)"
      />
    </div>
  </div>
</template>
