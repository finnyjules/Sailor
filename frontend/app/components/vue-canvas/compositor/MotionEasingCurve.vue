<script setup lang="ts">
/** Cubic-bézier curve editor for one motionx ease. Interaction + fitting ported from DialKit's
 *  easing control (MIT, joshpuckett/dialkit): two draggable handles, equal-axis fit so the 0→1
 *  reference stays at 45° during overshoot, arrow-key nudges, Escape cancels a drag. Sailor skin.
 *  A drag is ONE edit: `start` fires on pointer-down, `change` while moving, `end` on release. */
import type { Ease, BezierEase, NamedEase } from '~/lib/motionx'
import { easeToBezier, easeEquals } from '~/lib/motionx/ease'
import {
  fitEasingGraph, moveEasingHandle, easingGuideEnd, easingHandleFromKey, normalizeEase,
  parseEase, formatEase, type GraphPoint,
} from '~/lib/motionx/easingGraph'

const props = defineProps<{ ease: Ease }>()
const emit = defineEmits<{ start: []; change: [ease: Ease]; end: [] }>()

const PRESETS: Array<{ v: Ease; l: string; title: string }> = [
  { v: 'linear', l: 'Linear', title: 'Constant speed' },
  { v: 'easeIn', l: 'In', title: 'Starts slow' },
  { v: 'easeOut', l: 'Out', title: 'Ends slow' },
  { v: 'easeInOut', l: 'Smooth', title: 'Slow at both ends' },
  { v: [0.34, 1.56, 0.64, 1], l: 'Overshoot', title: 'Goes past the value, then settles' },
  { v: [0.36, 0, 0.66, -0.56], l: 'Anticipate', title: 'Pulls back before it goes' },
]

const box = ref<HTMLElement | null>(null)
const size = reactive({ w: 256, h: 180 })
const value = computed<BezierEase>(() => normalizeEase(easeToBezier(props.ease)))
const graph = computed(() => fitEasingGraph(value.value, size.w, size.h))
const guides = computed(() => [
  { a: graph.value.start, b: easingGuideEnd(graph.value.start, graph.value.handles[0]) },
  { a: graph.value.end, b: easingGuideEnd(graph.value.end, graph.value.handles[1]) },
])
const curveD = computed(() => {
  const { start, end, handles: [a, b] } = graph.value
  return `M ${start.x} ${start.y} C ${a.x} ${a.y}, ${b.x} ${b.y}, ${end.x} ${end.y}`
})

let ro: ResizeObserver | null = null
function measure() {
  if (!box.value) return
  size.w = box.value.clientWidth || size.w
  size.h = box.value.clientHeight || size.h
}
onMounted(() => { measure(); ro = new ResizeObserver(measure); if (box.value) ro.observe(box.value) })
onBeforeUnmount(() => { ro?.disconnect(); ro = null })

// ── Drag ─────────────────────────────────────────────────────────────────────
type Drag = { id: number; handle: 0 | 1; x: number; y: number; scale: GraphPoint; rx: number; ry: number; from: BezierEase; fromEase: Ease }
const drag = ref<Drag | null>(null)

function onDown(e: PointerEvent, handle: 0 | 1) {
  if (e.button !== 0 || drag.value || !box.value) return
  e.preventDefault()
  e.stopPropagation()
  const el = e.currentTarget as HTMLElement
  el.focus({ preventScroll: true })
  measure()
  const b = box.value.getBoundingClientRect()
  if (!b.width || !b.height) return
  drag.value = {
    id: e.pointerId, handle, x: e.clientX, y: e.clientY, scale: graph.value.scale,
    rx: size.w / b.width, ry: size.h / b.height, from: [...value.value] as BezierEase, fromEase: props.ease,
  }
  el.setPointerCapture(e.pointerId)
  emit('start')
}
function onMove(e: PointerEvent) {
  const d = drag.value
  if (!d || e.pointerId !== d.id) return
  const next = moveEasingHandle(d.from, d.handle, (e.clientX - d.x) * d.rx, (e.clientY - d.y) * d.ry, d.scale)
  if (!easeEquals(next, value.value)) emit('change', next)
}
function endDrag(e?: PointerEvent) {
  const d = drag.value
  if (!d || (e && e.pointerId !== d.id)) return
  drag.value = null
  emit('end')
}
function cancelDrag() {
  const d = drag.value
  if (!d) return
  drag.value = null
  emit('change', d.fromEase)
  emit('end')
}
function onKey(e: KeyboardEvent, handle: 0 | 1) {
  if (e.altKey || e.metaKey || e.ctrlKey) return
  if (e.key === 'Escape' && drag.value) { e.preventDefault(); e.stopPropagation(); cancelDrag(); return }
  const next = easingHandleFromKey(value.value, handle, e.key, e.shiftKey)
  if (!next) return
  e.preventDefault()
  e.stopPropagation()
  commitOnce(next)
}

function commitOnce(next: Ease) {
  if (easeEquals(next, props.ease)) return
  emit('start'); emit('change', next); emit('end')
}

// ── Typed handles ────────────────────────────────────────────────────────────
const shown = (v: BezierEase) => formatEase(v.map((n) => +n.toFixed(2)) as BezierEase)
const text = ref(shown(value.value))
const textBad = ref(false)
watch(value, (v) => { text.value = shown(v); textBad.value = false })
function onText() {
  const parsed = parseEase(text.value)
  textBad.value = !parsed
  if (parsed) commitOnce(parsed)
}
const isNamed = (e: Ease): e is NamedEase => typeof e === 'string'
</script>

<template>
  <div data-testid="easing-curve">
    <div ref="box" role="group" aria-label="Easing curve"
      class="relative w-full overflow-hidden rounded border border-white/10 bg-[#0d0d0d]"
      style="aspect-ratio: 256 / 180; isolation: isolate">
      <svg class="pointer-events-none absolute inset-0 h-full w-full" :viewBox="`0 0 ${size.w} ${size.h}`" aria-hidden="true">
        <line :x1="graph.start.x" :y1="graph.start.y" :x2="graph.end.x" :y2="graph.end.y"
          stroke="rgba(255,255,255,.22)" stroke-width="1" stroke-dasharray="3 4" />
        <line v-for="(g, i) in guides" :key="i" :x1="g.a.x" :y1="g.a.y" :x2="g.b.x" :y2="g.b.y"
          stroke="rgba(255,255,255,.35)" stroke-width="1" />
        <path :d="curveD" fill="none" stroke="#7c9cff" stroke-width="2" stroke-linecap="round" data-testid="easing-path" />
        <circle :cx="graph.start.x" :cy="graph.start.y" r="2.5" fill="rgba(255,255,255,.55)" />
        <circle :cx="graph.end.x" :cy="graph.end.y" r="2.5" fill="rgba(255,255,255,.55)" />
      </svg>
      <button v-for="h in ([0, 1] as const)" :key="h" type="button" data-owns-keys
        class="ease-handle" :data-dragging="drag?.handle === h ? 'true' : undefined" :data-testid="`easing-handle-${h}`"
        :aria-label="`Curve handle ${h + 1}: X ${+value[h * 2]!.toFixed(2)}, Y ${+value[h * 2 + 1]!.toFixed(2)}`"
        :style="{ left: `${(graph.handles[h].x / size.w) * 100}%`, top: `${(graph.handles[h].y / size.h) * 100}%` }"
        @pointerdown="onDown($event, h)" @pointermove="onMove" @pointerup="(e) => { onMove(e); endDrag(e) }"
        @pointercancel="cancelDrag" @lostpointercapture="endDrag" @keydown="onKey($event, h)" />
    </div>

    <div class="mt-1.5 flex flex-wrap gap-1">
      <button v-for="p in PRESETS" :key="p.l" type="button" :title="p.title"
        class="cursor-pointer rounded border px-1.5 py-0.5 text-[11px]"
        :class="easeEquals(ease, p.v) ? 'border-[#7c9cff] bg-[#7c9cff] font-medium text-black' : 'border-white/15 text-white/60 hover:text-white/90 hover:bg-white/5'"
        @click="commitOnce(p.v)">{{ p.l }}</button>
    </div>
    <input v-model="text" type="text" spellcheck="false" data-testid="easing-text"
      :title="isNamed(ease) ? 'Curve handles: x1, y1, x2, y2 — edit to make a custom curve' : 'Curve handles: x1, y1, x2, y2'"
      class="mt-1.5 w-full rounded border bg-[#0d0d0d] px-2 py-1 tabular-nums text-white/80 outline-none"
      :class="textBad ? 'border-rose-400/70' : 'border-white/15 focus:border-[#7c9cff]/70'"
      @change="onText" @keydown.enter.prevent="onText" @keydown.stop>
  </div>
</template>

<style scoped>
.ease-handle {
  position: absolute;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  transform: translate(-50%, -50%);
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  outline: none;
}
.ease-handle::after {
  content: '';
  width: 10px;
  height: 10px;
  box-sizing: border-box;
  border: 1.5px solid rgba(255, 255, 255, 0.65);
  border-radius: 50%;
  background: #0d0d0d;
}
.ease-handle:hover::after,
.ease-handle:focus-visible::after,
.ease-handle[data-dragging]::after {
  border-color: #7c9cff;
  background: #7c9cff;
}
.ease-handle[data-dragging] {
  cursor: grabbing;
  z-index: 1;
}
</style>
