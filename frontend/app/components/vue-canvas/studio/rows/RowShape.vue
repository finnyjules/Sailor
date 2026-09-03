<script setup lang="ts">
// Value side of a `shape` row: the current shape as a 16px glyph plus its name
// (or "None"), which opens the shared ShapePicker under the row. The row shell
// (StudioRow) draws the label; this renders only the value, like every renderer.
import { computed, ref } from 'vue'
import type { ControlSpec } from '~/lib/spacetype/effect'
import { shapeById } from '~/lib/shapes/catalog'
import ShapePicker from '../ShapePicker.vue'

const props = defineProps<{ value: string | number | boolean; spec: ControlSpec; step: number; editing: boolean }>()
const emit = defineEmits<{ (e: 'update:value', v: string): void }>()

const current = computed(() => shapeById(String(props.value)))
const allowNone = computed(() => (props.spec as { allowNone?: boolean }).allowNone !== false)
const open = ref(false)
const anchor = ref({ x: 0, y: 0 })

function openPicker(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  anchor.value = { x: r.right - 360, y: r.bottom + 4 }
  open.value = true
}
</script>

<template>
  <button
    type="button"
    :aria-label="spec.label"
    class="flex h-6 items-center gap-1.5 rounded-[6px] px-1.5 text-[11px] text-white/90 transition-colors hover:bg-white/[0.06]"
    @pointerdown.stop
    @click="openPicker"
  >
    <svg v-if="current" viewBox="0 0 96 96" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path :d="current.d" :fill-rule="current.fillRule" />
    </svg>
    <span>{{ current ? current.name : 'None' }}</span>
  </button>
  <ShapePicker
    v-if="open"
    :model-value="String(value)"
    :allow-none="allowNone"
    :anchor="anchor"
    @update:model-value="(v: string) => emit('update:value', v)"
    @close="open = false"
  />
</template>
