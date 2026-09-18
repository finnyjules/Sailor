<script setup lang="ts">
// Value side of a `shapeList` row: the hand-picked shapes as small glyph chips
// (with a +N overflow), opening the shared ShapePicker in multi-select mode. The
// value is a JSON array of shape ids; toggling a tile adds/removes an id.
import { computed, ref } from 'vue'
import type { ControlSpec } from '~/lib/spacetype/effect'
import { shapeById } from '~/lib/shapes/catalog'
import { SHAPE_PICKER_WIDTH } from '~/lib/shapes/pickerLayout'
import ShapePicker from '../ShapePicker.vue'

const props = defineProps<{ value: string | number | boolean; spec: ControlSpec; step: number; editing: boolean }>()
const emit = defineEmits<{ (e: 'update:value', v: string): void }>()

const MAX_CHIPS = 5

const ids = computed<string[]>(() => {
  try { const p = JSON.parse(String(props.value ?? '[]')); return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [] }
  catch { return [] }
})
const chips = computed(() => ids.value.map(id => shapeById(id)).filter((s): s is NonNullable<typeof s> => !!s))
const overflow = computed(() => Math.max(0, chips.value.length - MAX_CHIPS))

const open = ref(false)
const anchor = ref({ x: 0, y: 0 })
const btnRef = ref<HTMLButtonElement | null>(null)

function togglePicker() {
  if (open.value) { open.value = false; return }
  const el = btnRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  anchor.value = { x: r.right - SHAPE_PICKER_WIDTH, y: r.bottom + 4 }
  open.value = true
}

function toggleId(id: string) {
  const next = ids.value.includes(id) ? ids.value.filter(x => x !== id) : [...ids.value, id]
  emit('update:value', JSON.stringify(next))
}
</script>

<template>
  <span class="contents">
    <button
      ref="btnRef"
      type="button"
      :aria-label="spec.label"
      class="flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[11px] text-white/90 transition-colors hover:bg-white/[0.06]"
      @pointerdown.stop
      @click="togglePicker"
    >
      <template v-if="chips.length">
        <svg
          v-for="s in chips.slice(0, MAX_CHIPS)" :key="s.id"
          viewBox="0 0 96 96" width="14" height="14" fill="currentColor" aria-hidden="true"
        >
          <path :d="s.d" :fill-rule="s.fillRule" />
        </svg>
        <span v-if="overflow" class="text-white/50">+{{ overflow }}</span>
      </template>
      <span v-else class="text-white/50">None</span>
    </button>
    <ShapePicker
      v-if="open"
      :model-value="''"
      :multiple="true"
      :selected-ids="ids"
      :allow-none="false"
      :anchor="anchor"
      :ignore="btnRef"
      @toggle="toggleId"
      @close="open = false"
    />
  </span>
</template>
