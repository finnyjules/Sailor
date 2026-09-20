<script setup lang="ts">
// Prop-driven entry point for a select row. Two branches, exactly the shape
// StudioSwitch already uses for the same situation.
//
// WITH a `label` this is a 28px StudioRow like every other studio control.
//
// WITHOUT one it is the plain full-width <select> it always was, because all 22
// existing call sites sit inside `<div><label class="mb-1 block">X</label>
// <StudioSelect/></div>` — the surface draws the label itself. Routed through
// StudioRow those turned into a right-aligned ≥64px chip floating in a grey row
// whose own label was blank. Dropping the empty label span is NOT the fix: the row
// is `justify-between`, so with nothing on the left the chip slides to the LEFT
// edge, which reads worse than the chip did.
import { computed } from 'vue'
import type { ControlSpec } from '~/lib/spacetype/effect'
import StudioRow from './StudioRow.vue'

const model = defineModel<string>({ required: true })
const props = defineProps<{ options: string[]; optionLabels?: string[]; optionGroups?: string[]; label?: string; hint?: string }>()

// `optionGroups` pairs with `options` by index: consecutive options sharing a heading
// render under one <optgroup>. Only the plain (label-less) branch groups — it is the one
// long pickers use.
const grouped = computed(() => {
  if (!props.optionGroups) return null
  const out: { heading: string; items: { value: string; text: string }[] }[] = []
  props.options.forEach((value, i) => {
    const heading = props.optionGroups![i] ?? ''
    if (!out.length || out[out.length - 1]!.heading !== heading) out.push({ heading, items: [] })
    out[out.length - 1]!.items.push({ value, text: props.optionLabels?.[i] ?? value })
  })
  return out
})

const spec = computed(() => ({
  key: 'inline', label: props.label ?? '', kind: 'select',
  options: props.options, default: props.options[0] ?? '', group: '',
  ...(props.optionLabels ? { optionLabels: props.optionLabels } : {}),
  ...(props.hint ? { hint: props.hint } : {}),
} as ControlSpec))
</script>

<template>
  <select
    v-if="!label"
    v-model="model"
    class="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-xs text-white/85 outline-none focus-visible:ring-2 focus-visible:ring-white/20"
  >
    <template v-if="grouped">
      <optgroup v-for="g in grouped" :key="g.heading" :label="g.heading" class="bg-neutral-900">
        <option v-for="o in g.items" :key="o.value" :value="o.value" class="bg-neutral-900">{{ o.text }}</option>
      </optgroup>
    </template>
    <template v-else>
      <option v-for="(o, i) in options" :key="o" :value="o" class="bg-neutral-900" :class="{ capitalize: !optionLabels }">{{ optionLabels?.[i] ?? o }}</option>
    </template>
  </select>
  <!-- `:bindable="false"` on purpose. StudioRow shows the variable glyph by default
       and `select` is a bindable kind, so without this a labelled prop-driven select
       would grow a hexagon whose click emits `promote` into a component that declares
       no such emit — a visible affordance that does nothing. Schema-driven selects
       reach StudioRow through StudioControlPanel, which does wire promotion. -->
  <StudioRow
    v-else
    :spec="spec" :model-value="model" :bindable="false"
    @update:model-value="(v) => (model = String(v))"
  />
</template>
