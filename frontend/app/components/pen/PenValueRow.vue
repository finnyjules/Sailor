<!-- app/components/pen/PenValueRow.vue -->
<script setup lang="ts">
// The pen's inline value request — replaces the four window.prompt() calls
// (Distance/Radius/Copies) so the pen can live inside the Frame editor, which
// cannot host a browser-native prompt. Renders only while `pen.valueRequest`
// is set (usePen.ts's requestValue/submitValue/cancelValue); PenToolbar shows
// this as its top row (layout A).
import { ref, watch, nextTick } from 'vue'
import type { Pen } from '~/composables/pen/usePen'

const props = defineProps<{ pen: Pen }>()
const { valueRequest, submitValue, cancelValue } = props.pen

const draft = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

// re-seed the draft and (re)focus every time a new request comes in —
// including a second request replacing a still-pending one.
watch(valueRequest, (req) => {
  if (!req) return
  draft.value = String(req.initial)
  nextTick(() => inputEl.value?.focus())
}, { immediate: true })

function tryCommit() {
  const req = valueRequest.value
  if (!req) return
  const n = Number(draft.value)
  if (!Number.isFinite(n)) return                          // ignored — not a number
  if (req.min != null && n < req.min) return                // ignored — below the floor
  submitValue(n)
}
// stopPropagation on BOTH keys, not just Escape: this field lives inside the
// pen's own toolbar, above a host (PenOverlay, the dev page) whose window
// keydown listeners treat an un-stopped Enter as "commit the session" and
// Escape as "cancel" — exactly the pen's own key-ownership contract
// (usePen.ts's onKeydown), which this input isn't part of and must not leak
// into.
function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); tryCommit() }
  else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancelValue() }
}
</script>

<template>
  <div v-if="valueRequest" class="pen-value-row" role="group" :aria-label="valueRequest.label">
    <span class="label">{{ valueRequest.label }}</span>
    <input ref="inputEl" v-model="draft" type="number" class="value-input" data-testid="pen-value-input"
           :min="valueRequest.min" @keydown="onKeydown" />
    <button class="tbtn ok" data-act="value-submit" title="Apply" aria-label="Apply" @click="tryCommit()">✓</button>
  </div>
</template>

<style scoped>
.pen-value-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: color-mix(in srgb, #1a1a1a 97%, transparent);
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.label {
  font: 500 12px/1 ui-sans-serif, system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.8);
  white-space: nowrap;
}
.value-input {
  width: 72px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  font: 500 12px/1 ui-sans-serif, system-ui, sans-serif;
}
.value-input:focus { outline: none; border-color: rgba(147, 197, 253, 0.6); }
.tbtn.ok {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  min-width: 28px;
  border: 0;
  border-radius: 6px;
  background: rgba(47, 107, 255, 0.18);
  color: #b9ccff;
  cursor: pointer;
  font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
}
.tbtn.ok:hover { background: rgba(47, 107, 255, 0.28); }
</style>
