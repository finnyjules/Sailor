<script setup lang="ts">
// Prop-driven entry point for a numeric row. Builds a one-element ControlSpec and
// renders StudioRow — so surfaces that have no ControlSpec still get exactly the
// row the schema-driven studios get, and there is one render path, not two.
//
// The public props are unchanged from the version this replaces; every existing
// call site keeps working untouched.
import { computed } from 'vue'
import type { ControlSpec } from '~/lib/spacetype/effect'
import StudioRow from './StudioRow.vue'

const model = defineModel<number>({ required: true })
const props = defineProps<{
  label?: string
  min: number
  max: number
  step?: number
  default?: number
  bound?: string | null
  // Absent means FALSE here (Vue casts an absent Boolean prop), and that is the
  // behaviour to keep: StudioRow shows the glyph by default, but the ~90 prop-driven
  // call sites have no `@promote` listener, so a glyph on them would be a button that
  // silently does nothing. Only a caller that wired promotion asks for it.
  bindable?: boolean
  // No `scrubPx`. It was declared but never forwarded — StudioRow neither accepts it
  // nor passes it to `scrubValue` — and no call site set it. `scrubValue` still takes
  // one for the `v-scrub` directive, which does forward `b.scrubPx`.
  hint?: string
  size?: 'compact' | 'comfortable'
}>()
const emit = defineEmits<{ (e: 'promote'): void; (e: 'menu', event: MouseEvent): void }>()

const spec = computed(() => ({
  key: 'inline', label: props.label ?? '', kind: 'slider',
  min: props.min, max: props.max, step: props.step ?? 1,
  // OMITTED when the caller declared none, never defaulted to `min`. `resetValue`
  // treats a present default as absolute truth, so `?? props.min` made its
  // bipolar→0 rule unreachable and double-click sent Pitch (-90..90), Offset (-1..1)
  // and both -π..π angles to their minimum instead of to zero.
  ...(props.default != null ? { default: props.default } : {}),
  group: '',
  ...(props.hint ? { hint: props.hint } : {}),
} as ControlSpec))
</script>

<template>
  <StudioRow
    :spec="spec"
    :model-value="model"
    :bound="bound ?? null"
    :bindable="bindable"
    :size="size"
    @update:model-value="(v) => (model = Number(v))"
    @promote="emit('promote')"
    @menu="(e) => emit('menu', e)"
  />
</template>
