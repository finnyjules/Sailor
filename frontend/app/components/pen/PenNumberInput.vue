<!-- app/components/pen/PenNumberInput.vue -->
<script setup lang="ts">
// The pen's inline number field (pen stage 6: split out of PenValueRow so the
// Properties panel types sizes the same way). Enter submits a finite number
// at or above `min` (an empty field, or anything else, is ignored); Escape
// puts the shown value back. Both keys are stopped here: hosts leave typing
// to the field (their capture listeners return while a field has focus), so
// an Enter or Escape that bubbled on would commit or close the host (Shape
// Studio's shell closes on a bubbling Escape).
//
// Enter-only: leaving the field puts the shown value back (`revertOnBlur`,
// the Properties panel's sizes). The value row turns that off — its ✓ button
// takes focus before its click, and must still commit what was typed. After
// a submit the field shows `value` again (a refused size keeps the old one).
//
// `commitOnBlur` (the Repeat panel, pen stage 8): leaving the field (Tab, a
// click elsewhere) commits a changed, valid value as `change` and puts back an
// invalid one; Enter's `submit` then also says whether the text had changed
// from what the field showed. `flush()` does what leaving does, for a button that
// keeps the focus in the field through its click.
import { nextTick, ref, watch } from 'vue'

defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{ value: number; min?: number; disabled?: boolean; revertOnBlur?: boolean; commitOnBlur?: boolean }>(), {
  min: undefined, disabled: false, revertOnBlur: true, commitOnBlur: false,
})
const emit = defineEmits<{ submit: [value: number, changed?: boolean]; change: [value: number]; cancel: [] }>()
const show = (v: number) => (Number.isFinite(v) ? String(Number(v.toFixed(2))) : '')
const draft = ref(show(props.value))
const el = ref<HTMLInputElement | null>(null)
watch(() => props.value, (v) => { draft.value = show(v) })

function revert() { draft.value = show(props.value) }
const text = () => String(draft.value ?? '').trim()   // v-model on type=number may hand back a number
// the typed number, or null when it is no number or below `min`
function typed(): number | null {
  const t = text(), n = Number(t)
  if (t === '' || !Number.isFinite(n)) return null
  return props.min != null && n < props.min ? null : n
}
function commit() {
  const n = typed()
  if (n == null) return
  if (props.commitOnBlur) emit('submit', n, text() !== show(props.value))
  else emit('submit', n)
  // the value changed → the watch shows it; refused → the old value comes back
  void nextTick(revert)
}
// leaving the field (commitOnBlur): a changed, valid value commits; anything
// else shows the value again. False when what was typed was no value.
function flush(): boolean {
  if (text() === show(props.value)) return true
  const n = typed()
  if (n == null) { revert(); return false }
  emit('change', n)
  void nextTick(revert)
  return true
}
function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); commit() }
  else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); revert(); emit('cancel') }
}
function onBlur() {
  if (props.commitOnBlur) flush()
  else if (props.revertOnBlur) revert()
}
defineExpose({ focus: () => el.value?.focus(), commit, flush })
</script>

<template>
  <input ref="el" v-model="draft" v-bind="$attrs" type="number" step="any" class="pen-number"
         :min="min" :disabled="disabled" @keydown="onKeydown" @blur="onBlur" />
</template>

<style scoped>
.pen-number {
  width: 72px; min-width: 0; height: 28px; padding: 0 8px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06); color: #fff; font: 500 12px/1 ui-sans-serif, system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
}
.pen-number:focus { outline: none; border-color: rgba(147, 197, 253, 0.6); }
.pen-number:disabled { opacity: 0.45; cursor: default; }
</style>
