<!-- app/components/pen/PenActionWheel.vue -->
<script setup lang="ts">
// The pen's action wheel (pen stage 6): eight slices round the right-press
// point, drawn from `pen.wheel` (penActions.ts wheelFor). Look only — the
// overlay holds the pointer and tells the pen where it is (wheelPointer), the
// release picks (releaseWheel). A note under it names the slice under the
// pointer, or says why it is greyed. Teleported to <body>, above every modal.
import { computed } from 'vue'
import type { Pen } from '~/composables/pen/usePen'
import { WHEEL_R, WHEEL_DEAD_PX, WHEEL_LABEL_R, WHEEL_DIRS, type WheelDir } from '~/composables/pen/penActions'

const props = defineProps<{ pen: Pen }>()
const { wheel } = props.pen
const SIZE = WHEEL_R * 2 + 8
// slice i of WHEEL_DIRS is centred on i·45° counter-clockwise from east (y down on screen)
const angleOf = (dir: WheelDir) => WHEEL_DIRS.indexOf(dir) * Math.PI / 4
const at = (r: number, a: number) => ({ x: r * Math.cos(a), y: -r * Math.sin(a) })
function slicePath(dir: WheelDir): string {
  const a = angleOf(dir), h = Math.PI / 8 - 0.02
  const o1 = at(WHEEL_R, a + h), o2 = at(WHEEL_R, a - h), i1 = at(WHEEL_DEAD_PX, a - h), i2 = at(WHEEL_DEAD_PX, a + h)
  return `M ${o1.x} ${o1.y} A ${WHEEL_R} ${WHEEL_R} 0 0 1 ${o2.x} ${o2.y} L ${i1.x} ${i1.y} A ${WHEEL_DEAD_PX} ${WHEEL_DEAD_PX} 0 0 0 ${i2.x} ${i2.y} Z`
}
const labelAt = (dir: WheelDir) => at(WHEEL_LABEL_R, angleOf(dir))
const note = computed(() => {
  const w = wheel.value
  const s = w?.hover ? w.slices.find(x => x.dir === w.hover) : null
  return s ? (s.state.ok ? s.label : s.state.reason) : ''
})
</script>

<template>
  <Teleport to="body">
    <div v-if="wheel" data-pen-wheel :data-layout="wheel.layout" class="pen-wheel"
         :style="{ left: wheel.at.x - SIZE / 2 + 'px', top: wheel.at.y - SIZE / 2 + 'px', width: SIZE + 'px', height: SIZE + 'px' }">
      <svg :width="SIZE" :height="SIZE" :viewBox="`${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`" aria-hidden="true">
        <g v-for="s in wheel.slices" :key="s.dir" :data-wheel-slice="s.dir" :data-action="s.id"
           :data-greyed="s.state.ok ? null : ''" :data-hover="wheel.hover === s.dir ? '' : null" class="slice">
          <path :d="slicePath(s.dir)" />
          <text :x="labelAt(s.dir).x" :y="labelAt(s.dir).y" text-anchor="middle" dominant-baseline="middle">{{ s.label }}</text>
        </g>
        <circle :r="WHEEL_DEAD_PX - 4" class="hub" />
      </svg>
      <div v-if="note" class="pen-wheel-note" data-pen-wheel-note>{{ note }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.pen-wheel { position: fixed; z-index: 10040; pointer-events: none; }
.slice path { fill: rgba(20, 20, 20, 0.92); stroke: rgba(255, 255, 255, 0.12); stroke-width: 1; }
.slice text { fill: rgba(255, 255, 255, 0.88); font: 500 11px/1 ui-sans-serif, system-ui, sans-serif; }
.slice[data-hover] path { fill: #2f6bff; }
.slice[data-hover] text { fill: #fff; }
.slice[data-greyed] text { fill: rgba(255, 255, 255, 0.35); }
.slice[data-greyed][data-hover] path { fill: rgba(60, 60, 60, 0.95); }
.hub { fill: rgba(20, 20, 20, 0.92); stroke: rgba(255, 255, 255, 0.2); }
.pen-wheel-note {
  position: absolute; left: 50%; top: 100%; transform: translateX(-50%); margin-top: 4px; white-space: nowrap;
  padding: 3px 8px; border-radius: 6px; background: rgba(10, 10, 10, 0.85); color: rgba(255, 255, 255, 0.85);
  font: 500 11.5px/1.3 ui-sans-serif, system-ui, sans-serif;
}
</style>
