<script setup lang="ts">
// Value side of a select row: the current option, right-aligned, with the native
// select laid transparently over it so the OS menu still opens where expected.
import { computed } from 'vue'
import type { ControlSpec } from '~/lib/spacetype/effect'

const props = defineProps<{ value: string; spec: ControlSpec; step: number; editing: boolean }>()
const emit = defineEmits<{ (e: 'update:value', v: string): void }>()
// Computed, not a setup-time snapshot: a row keeps ONE component instance for the
// life of its key, and several select specs get their options late or from live
// state — `shaderFillControls`' `effectId` ships `options: []` on purpose and the
// host merges the fetched 63-effect catalog in afterwards. Read once at setup, that
// row would offer an empty menu forever. Measured on the harness: mutating a spec's
// options left the rendered <option> list on the old values.
const options = computed(() => (props.spec as { options?: string[] }).options ?? [])

// `optionLabels[i]` is the display text for `options[i]`, positionally paired —
// missing or shorter than `options` falls back to the raw value for that slot.
// PRESENTATION only: `model`/`v-model` below always carries the raw `options[i]`
// string, never the label, so a stored value never changes shape because of this.
const labelFor = (v: string): string => {
  const labels = (props.spec as { optionLabels?: string[] }).optionLabels
  if (!labels) return v
  const i = options.value.indexOf(v)
  return i >= 0 ? (labels[i] ?? v) : v
}

// `v-model`, NOT `:value` + `@change`, and the reason is SELECTEDNESS, not the value
// binding. The failure this guards against: HTML resets a select's selectedness whenever
// its option list changes, so a value set against an EMPTY select matches nothing
// (`selectedIndex === -1`) and, once options are appended, the reset picks the FIRST
// option instead. That would leave the row's text showing the stored value while the
// native control reported `options[0]` — the menu opens on the wrong row, and picking
// `options[0]` fires no `change` at all, so it is unpickable.
//
// HONEST NOTE, because this was measured rather than reasoned: `:value` does NOT
// actually break here at Vue 3. Both of Vue's prop-patch paths special-case
// `key === 'value'` and re-patch it even when it is unchanged, and `patchElement`
// patches children BEFORE props — so `el.value` is re-asserted after the new options
// exist. Counterfactual on the harness, `:value` + `@change`, the effectId spec's
// options merged in after mount with a stored value of `topographic`: selectedIndex went
// -1 → 3, i.e. correct. `v-model` is kept anyway because it makes the guarantee
// explicit and cheap: vModelSelect sets `option.selected` from an `updated` hook, which
// is the mechanism that survives Vue changing the `key === 'value'` fast path.
//
// Verified with real input on the late-populated select: picking `options[0]` fired one
// `change`, wrote once, and the row text and `select.value` agreed.
const model = computed({
  get: () => props.value,
  set: (v: string) => emit('update:value', v),
})

// `optionGroups[i]` is the <optgroup> heading for `options[i]`, positionally paired like
// `optionLabels` — consecutive options sharing a heading render under one group. Same rule
// StudioSelect's own plain-select branch uses, so a picker reads identically whichever
// branch renders it.
const grouped = computed(() => {
  const headings = (props.spec as { optionGroups?: string[] }).optionGroups
  if (!headings) return null
  const out: { heading: string; items: string[] }[] = []
  options.value.forEach((o, i) => {
    const heading = headings[i] ?? ''
    if (!out.length || out[out.length - 1]!.heading !== heading) out.push({ heading, items: [] })
    out[out.length - 1]!.items.push(o)
  })
  return out
})
</script>

<template>
  <!-- `flex-1` so the row's min-width value box stretches this span, and with it the
       transparent `absolute inset-0` select below — the overlay resolves against THIS
       element, so a wider parent alone would not widen the click target. `justify-end`
       keeps the text where a right-aligned readout belongs once it is stretched. -->
  <!-- `gap-3`, not the `gap-1` this started at, because a rotated element keeps its
       UNROTATED layout box: the caret lays out 3.2px wide but paints across 16.5px, so
       ~6.6px of its mark bleeds back over the gap. 4px of gap therefore read as about
       −2.6px and the caret optically touched the value. 12px lands ~5.4px clear. -->
  <span class="relative flex flex-1 items-center justify-end gap-3 text-[11px] text-white/90">
    <!-- `capitalize` only applies to the raw fallback — an `optionLabels` string
         dictates its OWN casing (e.g. focus.shape's 'Off — blur everything' is prose,
         not a title), so title-casing it here would be wrong. -->
    <span :class="{ capitalize: !(spec as { optionLabels?: string[] }).optionLabels }">{{ labelFor(value) }}</span>
    <!-- The SAME glyph and treatment as StudioSection's card caret — `›` turned 90°, not
         `⌄` (U+2304). The two sat side by side and disagreed: U+2304 draws smaller than the
         type size suggests and its ink sits off the optical centre, so it read as a
         different, sloppier control. Always rotated, because a select's caret always points
         down; the card's rotates on open. Colour matches the card's `white/30`. -->
    <span class="inline-block rotate-90 text-white/30">›</span>
    <!-- `-inset-y-1.5` because the span is only as tall as one 11px line — measured at
         17px inside a 28px row, so the menu opened from just the middle 60% of it.
         Bleeding the overlay 6px past its own box fills the row's height; it is
         absolutely positioned, so nothing reflows. -->
    <select
      v-model="model"
      :aria-label="spec.label"
      class="absolute inset-x-0 -inset-y-1.5 cursor-pointer opacity-0"
      @pointerdown.stop
    >
      <template v-if="grouped">
        <optgroup v-for="g in grouped" :key="g.heading" :label="g.heading" class="bg-neutral-900">
          <option
            v-for="o in g.items" :key="o" :value="o" class="bg-neutral-900"
            :class="{ capitalize: !(spec as { optionLabels?: string[] }).optionLabels }"
          >{{ labelFor(o) }}</option>
        </optgroup>
      </template>
      <template v-else>
        <option
          v-for="o in options" :key="o" :value="o" class="bg-neutral-900"
          :class="{ capitalize: !(spec as { optionLabels?: string[] }).optionLabels }"
        >{{ labelFor(o) }}</option>
      </template>
    </select>
  </span>
</template>
