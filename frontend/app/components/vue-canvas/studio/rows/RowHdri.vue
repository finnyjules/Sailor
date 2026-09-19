<script setup lang="ts">
// Value side of an `hdri` row: the current studio HDRI as a thumbnail + name, opening the
// browsable HdriPicker under the row. Mirrors RowLook. The bound value is the Poly Haven slug.
import { computed, ref } from 'vue'
import type { ControlSpec } from '~/lib/spacetype/effect'
import { hdriLabel } from '~/lib/scene3d/hdri'
import { hdriThumbUrl } from '~/lib/scene3d/hdriCatalog'
import { LOOK_PICKER_WIDTH } from '~/lib/shapes/pickerLayout'
import HdriPicker from '../HdriPicker.vue'

const props = defineProps<{ value: string | number | boolean; spec: ControlSpec; step: number; editing: boolean }>()
const emit = defineEmits<{ (e: 'update:value', v: string): void }>()

const slug = computed(() => String(props.value || ''))
// A readable name: the curated label if it's a Featured slug, else the slug prettified. The picker
// carries the real catalog names; here the thumbnail does most of the recognising.
const name = computed(() => {
  const s = slug.value
  const curated = hdriLabel(s)
  if (curated !== s) return curated
  return s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Choose…'
})

const open = ref(false)
const anchor = ref({ x: 0, y: 0 })
const btnRef = ref<HTMLButtonElement | null>(null)

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
      <span class="size-[18px] overflow-hidden rounded-[4px] bg-[#0d1016]">
        <img v-if="slug" :src="hdriThumbUrl(slug)" :alt="name" class="size-full object-cover" />
      </span>
      <span class="max-w-[150px] truncate">{{ name }}</span>
      <span class="text-white/40" aria-hidden="true">▾</span>
    </button>
    <HdriPicker
      v-if="open"
      :model-value="slug"
      :anchor="anchor"
      :ignore="btnRef"
      @update:model-value="(v: string) => emit('update:value', v)"
      @close="open = false"
    />
  </span>
</template>
