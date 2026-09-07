<script setup lang="ts">
/**
 * The Cloner Vary swatch list — the ONE palette editor, used by both the 3D
 * Studio inspector and the Frame cloner panel so the two surfaces stay
 * vocabulary-identical.
 *
 * Modelled on Shape Studio's inline fills editor, which is bespoke and stays
 * that way for now; this component is written so Shape Studio could adopt it
 * later without changing its data shape.
 */
import { computed } from 'vue'
import { DEFAULT_VARY, VARY_PALETTE_MAX } from '~/lib/vary'
import { parseHexA } from '~/lib/color/convert'

const props = defineProps<{ modelValue: string[] | undefined }>()
const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const palette = computed<string[]>(() =>
  props.modelValue && props.modelValue.length > 0 ? props.modelValue : DEFAULT_VARY.palette)

const canAdd = computed(() => palette.value.length < VARY_PALETTE_MAX)
const canRemove = computed(() => palette.value.length > 1)

// A native <input type="color"> only accepts a 6-digit hex — handed an 8-digit
// (hex+alpha, which this repo's own colour picker produces elsewhere) it shows
// black instead of the colour. Strip alpha for the swatch's DISPLAY value only;
// the stored entry keeps whatever form it already had until the user actually
// edits that swatch, at which point it becomes whatever the native picker emits.
function displayHex(c: string): string {
  return parseHexA(c).hex
}

function setAt(i: number, hex: string) {
  emit('update:modelValue', palette.value.map((c, j) => (j === i ? hex : c)))
}
function add() {
  if (!canAdd.value) return
  emit('update:modelValue', [...palette.value, palette.value[palette.value.length - 1] ?? '#ffffff'])
}
function removeAt(i: number) {
  if (!canRemove.value) return
  emit('update:modelValue', palette.value.filter((_, j) => j !== i))
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5">
    <div v-for="(c, i) in palette" :key="i" class="relative group">
      <input
        type="color" :value="displayHex(c)"
        class="size-6 rounded cursor-pointer bg-transparent border border-white/15 p-0"
        :aria-label="`Palette colour ${i + 1}`"
        @input="setAt(i, ($event.target as HTMLInputElement).value)"
      >
      <button
        v-if="canRemove"
        data-test="vary-palette-remove"
        class="absolute -top-1 -right-1 size-3.5 rounded-full bg-neutral-900 text-white/70 text-[9px] leading-none opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        :title="`Remove colour ${i + 1}`"
        @click="removeAt(i)"
      >×</button>
    </div>
    <button
      v-if="canAdd"
      data-test="vary-palette-add"
      class="size-6 rounded border border-dashed border-white/25 text-white/50 text-[13px] leading-none cursor-pointer hover:border-white/50 hover:text-white/80 transition-colors"
      title="Add a colour"
      @click="add"
    >+</button>
  </div>
</template>
