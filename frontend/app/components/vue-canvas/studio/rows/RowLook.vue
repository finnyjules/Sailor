<script setup lang="ts">
// Value side of a `look` row: the current Look as a small plotted thumbnail plus
// its name, which opens the LookPicker under the row. Mirrors RowShape exactly.
import { computed, ref } from 'vue'
import type { ControlSpec } from '~/lib/spacetype/effect'
import { getLook } from '~/lib/scene3d/lighting'
import { LOOK_PICKER_WIDTH } from '~/lib/shapes/pickerLayout'
import LookPlot from '../LookPlot.vue'
import LookPicker from '../LookPicker.vue'

const props = defineProps<{ value: string | number | boolean; spec: ControlSpec; step: number; editing: boolean }>()
const emit = defineEmits<{ (e: 'update:value', v: string): void }>()

const current = computed(() => getLook(String(props.value)))
const open = ref(false)
const anchor = ref({ x: 0, y: 0 })
const btnRef = ref<HTMLButtonElement | null>(null)

// The button is passed to the picker as `ignore`, so a press on it is not an
// outside click; this toggle is the only thing that decides open/closed.
function togglePicker() {
  if (open.value) { open.value = false; return }
  const el = btnRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  anchor.value = { x: r.right - LOOK_PICKER_WIDTH, y: r.bottom + 4 }
  open.value = true
}
</script>

<template>
  <span class="contents">
    <button
      ref="btnRef"
      type="button"
      :aria-label="spec.label"
      class="flex h-6 items-center gap-1.5 rounded-[6px] px-1.5 text-[11px] text-white/90 transition-colors hover:bg-white/[0.06]"
      @pointerdown.stop
      @click="togglePicker"
    >
      <span class="rounded-[4px] bg-[#0d1016]"><LookPlot :recipe="current" :size="18" /></span>
      <span>{{ current.label }}</span>
      <span class="text-white/40" aria-hidden="true">▾</span>
    </button>
    <LookPicker
      v-if="open"
      :model-value="String(value)"
      :anchor="anchor"
      :ignore="btnRef"
      @update:model-value="(v: string) => emit('update:value', v)"
      @close="open = false"
    />
  </span>
</template>
