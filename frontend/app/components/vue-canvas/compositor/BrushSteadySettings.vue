<!-- app/components/vue-canvas/compositor/BrushSteadySettings.vue -->
<script setup lang="ts">
// Steadying section of the brush inspector: streamline / stabilisation / motion
// filtering sliders, the hold-to-snap switch and its hold time. Values live on
// brush.steady (fractions 0-1); changes affect only the next stroke.
import { holdMsOf } from '~/lib/brushTips/steady'
import type { useBrushPaint } from '~/composables/useBrushPaint'

const props = defineProps<{ brush: ReturnType<typeof useBrushPaint> }>()

const ROWS = [
  { key: 'streamline', label: 'Streamline', title: 'The brush trails your finger a little and catches up, so curves come out smooth.' },
  { key: 'stabilise', label: 'Stabilisation', title: 'Averages the path, so slow careful strokes lose their wobble.' },
  { key: 'filter', label: 'Motion filtering', title: 'Removes small jitter without adding lag to fast strokes.' },
] as const

const SNAP_TITLE = 'Round and bristle: stop at the end of a stroke and keep holding to snap it to a line, arc, ellipse or shape. Keep holding and move to adjust. Shift makes a circle or a 15° line.'
const HOLD_TITLE = 'How long to hold still before it snaps.'

function pct(key: 'streamline' | 'stabilise' | 'filter' | 'hold'): number {
  return Math.round((props.brush.steady[key] ?? 0) * 100)
}
function setPct(key: 'streamline' | 'stabilise' | 'filter' | 'hold', v: number) {
  props.brush.steady[key] = v / 100
}
function toggleSnap() {
  props.brush.steady.snap = !props.brush.steady.snap
}
function holdLabel(): string {
  return (holdMsOf(props.brush.steady.hold) / 1000).toFixed(2) + ' s'
}
function reset() {
  props.brush.resetSteady()
}
</script>

<template>
  <div class="brush-steady-settings" data-testid="brush-steady-settings">
    <div class="header">Steadying</div>
    <div v-for="r in ROWS" :key="r.key" class="row">
      <span class="lbl" :title="r.title">{{ r.label }}</span>
      <input
        type="range" min="0" max="100" step="5"
        :value="pct(r.key)"
        :aria-label="r.label"
        :data-testid="`brush-steady-${r.key}`"
        @input="setPct(r.key, Number(($event.target as HTMLInputElement).value))"
      />
      <span class="val tabular-nums">{{ pct(r.key) }}%</span>
    </div>
    <div class="row">
      <span class="lbl" :title="SNAP_TITLE">Hold to snap</span>
      <button
        class="switch"
        type="button"
        data-testid="brush-steady-snap"
        :aria-pressed="brush.steady.snap"
        @click="toggleSnap()"
      >{{ brush.steady.snap ? 'On' : 'Off' }}</button>
    </div>
    <div v-if="brush.steady.snap" class="row">
      <span class="lbl" :title="HOLD_TITLE">Hold time</span>
      <input
        type="range" min="0" max="100" step="5"
        :value="pct('hold')"
        aria-label="Hold time"
        data-testid="brush-steady-hold"
        @input="setPct('hold', Number(($event.target as HTMLInputElement).value))"
      />
      <span class="val tabular-nums">{{ holdLabel() }}</span>
    </div>
    <button class="reset" data-testid="brush-steady-reset" @click="reset()">Reset</button>
  </div>
</template>

<style scoped>
.brush-steady-settings {
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
.switch {
  height: 22px;
  padding: 0 10px;
  border-radius: 999px;
  border: 0;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.75);
  font-size: 10px;
  cursor: pointer;
}
.switch:hover { background: rgba(255, 255, 255, 0.12); }
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
</style>
