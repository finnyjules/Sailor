<!-- app/components/vue-canvas/compositor/BrushToolbar.vue -->
<script setup lang="ts">
// Bottom toolbar for the Frame brush (spray can / round / bristle), mirroring
// PenToolbar's look (dark rounded bar + hint line under it). Consumes the
// useBrushPaint() return (Task 7) as `brush`, unmodified.
import { computed } from 'vue'
import type { useBrushPaint } from '~/composables/useBrushPaint'
import { TIPS, TIP_IDS, SIZE_MIN, SIZE_MAX, MASK_HINT } from '~/lib/brushTips/tips'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'

const props = defineProps<{ brush: ReturnType<typeof useBrushPaint> }>()
const emit = defineEmits<{ done: [] }>()

// `brush`'s refs are destructured out of a prop, so writing `x.value = …`
// directly in the template would go through Vue's setup-proxy auto-unwrap
// and throw ("Cannot create property 'value' on string"). Every read/write
// below routes through `props.brush.x.value` instead — `props` itself is
// not a ref, so no auto-unwrap kicks in on that chain.
const isMask = computed(() => props.brush.mode.value === 'mask')
const hint = computed(() => (isMask.value ? MASK_HINT : TIPS[props.brush.tip.value].hint))
const currentTipSize = computed(() => props.brush.tipSize[props.brush.tip.value])

function selectTip(id: (typeof TIP_IDS)[number]) { props.brush.tip.value = id }
function setTipSize(v: number) { props.brush.tipSize[props.brush.tip.value] = v }
function setSizePx(v: number) { props.brush.sizePx.value = v }
function setColor(v: string) { props.brush.color.value = v }
function toggleEraser() { props.brush.eraser.value = !props.brush.eraser.value }
function setMode(m: 'paint' | 'mask') { props.brush.mode.value = m }
function done() { emit('done') }
</script>

<template>
  <div class="brush-toolbar" data-testid="brush-toolbar">
    <div class="tb" role="toolbar" aria-label="Brush">
      <div class="row">
        <template v-if="!isMask">
          <button
            v-for="id in TIP_IDS" :key="id"
            class="tbtn" :data-testid="`brush-tip-${id}`"
            :aria-pressed="brush.tip.value === id" :title="TIPS[id].label"
            @click="selectTip(id)"
          >{{ TIPS[id].label }}</button>
          <span class="sep" />
        </template>
        <button
          class="tbtn" data-testid="brush-mode-paint"
          :aria-pressed="brush.mode.value === 'paint'" title="Paint"
          @click="setMode('paint')"
        >Paint</button>
        <button
          class="tbtn" data-testid="brush-mode-mask"
          :aria-pressed="brush.mode.value === 'mask'" title="Mask"
          @click="setMode('mask')"
        >Mask</button>
      </div>

      <div class="row">
        <template v-if="!isMask">
          <span class="lbl">Size</span>
          <input
            type="range" data-testid="brush-size"
            :min="SIZE_MIN" :max="SIZE_MAX" step="1"
            :value="currentTipSize"
            @input="setTipSize(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="val tabular-nums">{{ currentTipSize }}</span>
          <span class="sep" />
          <StudioColor :model-value="brush.color.value" @update:model-value="setColor" />
        </template>
        <template v-else>
          <span class="lbl">Size</span>
          <input
            type="range" data-testid="brush-size"
            min="2" max="240" step="1"
            :value="brush.sizePx.value"
            @input="setSizePx(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="val tabular-nums">{{ brush.sizePx.value }}</span>
        </template>
        <span class="sep" />
        <button
          class="tbtn" data-testid="brush-eraser"
          :aria-pressed="brush.eraser.value" title="Eraser"
          @click="toggleEraser()"
        >Eraser</button>
        <span class="sep" />
        <button class="tbtn primary" data-testid="brush-done" @click="done()">Done</button>
      </div>
    </div>

    <div class="hint-wrap">
      <div class="hint">{{ hint }}</div>
    </div>
  </div>
</template>

<style scoped>
/* Same dark chrome as PenToolbar: #1a1a1a bar, #2a2a2a border, white/80 text,
   pressed state white-on-dark. Rows wrap at laptop widths. */
.brush-toolbar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.tb {
  display: flex;
  flex-direction: column;
  min-width: 0;
  align-items: stretch;
  gap: 4px;
  padding: 6px;
  background: color-mix(in srgb, #1a1a1a 95%, transparent);
  border: 1px solid #2a2a2a;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  max-width: 380px;
  width: max-content;
}
.tb .row {
  display: flex;
  flex-wrap: wrap;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.tb .sep {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.1);
  margin: 0 4px;
  flex: none;
}
.lbl {
  color: rgba(255, 255, 255, 0.55);
  font-size: 11px;
  white-space: nowrap;
  flex: none;
}
.val {
  color: rgba(255, 255, 255, 0.7);
  font-size: 11px;
  min-width: 28px;
  text-align: right;
  flex: none;
}
input[type='range'] {
  accent-color: #fff;
  cursor: pointer;
  width: 90px;
}
.tbtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.8);
  font: 500 12px/1 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
  white-space: nowrap;
}
.tbtn:hover:not([aria-pressed='true']) { background: rgba(255, 255, 255, 0.08); }
.tbtn[aria-pressed='true'] { background: #fff; color: #111; }
.tbtn.primary { background: #2f6bff; color: #fff; }
.tbtn.primary:hover { background: #3f78ff; }
.hint-wrap { display: flex; max-width: 100%; }
.hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  background: rgba(10, 10, 10, 0.72);
  border-radius: 6px;
  padding: 3px 8px;
  max-width: 100%;
  text-align: center;
}
</style>
