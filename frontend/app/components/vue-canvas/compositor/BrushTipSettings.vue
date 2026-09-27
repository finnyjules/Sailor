<!-- app/components/vue-canvas/compositor/BrushTipSettings.vue -->
<script setup lang="ts">
// Right-panel section: the current brush tip's settings sliders (spray can /
// round / bristle). Values are stored as fractions (1 = 100%); every slider
// shows NN%. Changes affect only the next stroke — resetTipSettings(tip)
// restores the tuned defaults from lib/brushTips/tips.ts.
import { computed } from 'vue'
import type { useBrushPaint } from '~/composables/useBrushPaint'
import { TIPS } from '~/lib/brushTips/tips'
import BrushSteadySettings from './BrushSteadySettings.vue'

const props = defineProps<{ brush: ReturnType<typeof useBrushPaint> }>()

// Route every read/write through `props.brush.x.value` rather than
// destructuring `tip` (a ref) out of the prop — a destructured top-level ref
// gets auto-unwrapped by Vue's setup-proxy when referenced in the template,
// so `tip.value = …` there would set `.value` on the raw string, not the ref.
const tipDef = computed(() => TIPS[props.brush.tip.value])

function pct(key: string): number {
  return Math.round((props.brush.tipSettings[props.brush.tip.value][key] ?? 0) * 100)
}
function setPct(key: string, v: number) {
  props.brush.tipSettings[props.brush.tip.value][key] = v / 100
}
function reset() {
  props.brush.resetTipSettings(props.brush.tip.value)
}
</script>

<template>
  <div class="brush-tip-settings" data-testid="brush-tip-settings">
    <div class="header">Brush · {{ tipDef.label }}</div>
    <div v-for="st in tipDef.settings" :key="st.key" class="row">
      <span class="lbl" :title="st.label">{{ st.label }}</span>
      <input
        type="range" min="0" :max="st.max * 100" step="5"
        :value="pct(st.key)"
        :aria-label="st.label"
        @input="setPct(st.key, Number(($event.target as HTMLInputElement).value))"
      />
      <span class="val tabular-nums">{{ pct(st.key) }}%</span>
    </div>
    <button class="reset" data-testid="brush-tip-reset" title="Changes apply to your next stroke." @click="reset()">Reset to defaults</button>
    <div class="steady-divider">
      <BrushSteadySettings :brush="brush" />
    </div>
  </div>
</template>

<style scoped>
.brush-tip-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}
.header {
  font-size: 11px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.7);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}
.lbl {
  width: 96px;
  flex: none;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row input[type='range'] {
  flex: 1;
  min-width: 0;
  accent-color: #fff;
  cursor: pointer;
}
.val {
  width: 40px;
  flex: none;
  text-align: right;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.5);
}
.reset {
  align-self: flex-start;
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  border: 0;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.75);
  font-size: 11px;
  cursor: pointer;
}
.reset:hover { background: rgba(255, 255, 255, 0.12); }
.steady-divider {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding-top: 12px;
}
</style>
