<!-- app/components/pen/PenValueRow.vue -->
<script setup lang="ts">
// The pen's inline value request — replaces the four window.prompt() calls
// (Distance/Radius/Copies) so the pen can live inside the Frame editor, which
// cannot host a browser-native prompt. Renders only while `pen.valueRequest`
// is set (usePen.ts's requestValue/submitValue/cancelValue); PenToolbar shows
// this as its top row (layout A).
//
// The field is PenNumberInput (shared with the Properties panel since pen
// stage 6). It stops its own Enter and Escape: this row lives inside the
// pen's toolbar, above hosts (PenOverlay, the dev page) whose window keydown
// listeners treat an un-stopped Enter as "commit the session" and Escape as
// "cancel". It keeps what was typed when focus leaves it (`revert-on-blur`
// off), so the ✓ button — which takes focus before its click — commits it.
import { ref, watch, nextTick } from 'vue'
import type { Pen } from '~/composables/pen/usePen'
import PenNumberInput from '~/components/pen/PenNumberInput.vue'

const props = defineProps<{ pen: Pen }>()
const { valueRequest, submitValue, cancelValue } = props.pen
const field = ref<InstanceType<typeof PenNumberInput> | null>(null)

// (re)focus every time a new request comes in — including a second request
// replacing a still-pending one (the field is keyed on each request, so it
// re-seeds from the new initial value)
const seq = ref(0)
watch(valueRequest, (req) => {
  if (!req) return
  seq.value++
  nextTick(() => field.value?.focus())
}, { immediate: true })
</script>

<template>
  <div v-if="valueRequest" class="pen-value-row" role="group" :aria-label="valueRequest.label">
    <span class="label">{{ valueRequest.label }}</span>
    <PenNumberInput ref="field" :key="seq" :value="valueRequest.initial"
                    :min="valueRequest.min" :revert-on-blur="false" data-testid="pen-value-input"
                    @submit="submitValue" @cancel="cancelValue" />
    <button class="tbtn ok" data-act="value-submit" title="Apply" aria-label="Apply" @click="field?.commit()">✓</button>
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
