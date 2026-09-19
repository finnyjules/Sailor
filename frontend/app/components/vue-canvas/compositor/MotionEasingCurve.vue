<script setup lang="ts">
/** Transition editor for one motionx ease — a port of DialKit's TransitionControl (MIT,
 *  joshpuckett/dialkit) in Sailor's skin: the graph on top, then labelled rows — a Type switch
 *  (Easing / Spring), and either the bézier "Ease" field or the spring's Bounce slider. Each
 *  mode remembers its last value, so switching back restores it. The bézier graph keeps
 *  DialKit's fitting + drag + keyboard maths; the spring graph draws exactly what plays.
 *  DialKit's third mode (Physics: stiffness/damping/mass) is left out on purpose — its length
 *  is emergent, which fights a band whose bar IS the duration.
 *  A gesture is ONE edit: `start` on grab, `change` while moving, `end` on release. */
import type { Ease, BezierEase, SpringEase } from '~/lib/motionx'
import { easeToBezier, easeEquals, isSpringEase, springProgress, springSettle } from '~/lib/motionx/ease'
import {
  fitEasingGraph, moveEasingHandle, easingGuideEnd, easingHandleFromKey, normalizeEase,
  parseEase, formatEase, type GraphPoint,
} from '~/lib/motionx/easingGraph'

const props = defineProps<{ ease: Ease }>()
const emit = defineEmits<{ start: []; change: [ease: Ease]; end: [] }>()

type Mode = 'easing' | 'spring'
const MODES: Array<{ v: Mode; l: string }> = [{ v: 'easing', l: 'Easing' }, { v: 'spring', l: 'Spring' }]
const mode = computed<Mode>(() => (isSpringEase(props.ease) ? 'spring' : 'easing'))

// Per-mode memory (DialKit caches each mode so switching back restores previous edits).
const cache = reactive<{ easing: Ease; spring: SpringEase }>({
  easing: isSpringEase(props.ease) ? 'easeInOut' : props.ease,
  spring: isSpringEase(props.ease) ? props.ease : { type: 'spring', bounce: 0.2 },
})
watch(() => props.ease, (e) => { if (isSpringEase(e)) cache.spring = e; else cache.easing = e }, { immediate: true })

// Quick picks, as one more labelled row (DialKit has none; the named eases are Sailor's).
const PRESETS: Array<{ l: string; v: Ease }> = [
  { l: 'Linear', v: 'linear' }, { l: 'Ease in', v: 'easeIn' }, { l: 'Ease out', v: 'easeOut' },
  { l: 'Smooth', v: 'easeInOut' }, { l: 'Overshoot', v: [0.34, 1.56, 0.64, 1] }, { l: 'Anticipate', v: [0.36, 0, 0.66, -0.56] },
]
const presetIndex = computed(() => PRESETS.findIndex((p) => easeEquals(p.v, props.ease)))
function onPreset(e: Event) {
  const i = Number((e.target as HTMLSelectElement).value)
  if (PRESETS[i]) commitOnce(PRESETS[i]!.v)
}

function commitOnce(next: Ease) {
  if (easeEquals(next, props.ease)) return
  emit('start'); emit('change', next); emit('end')
}
function setMode(m: Mode) { if (m !== mode.value) commitOnce(m === 'spring' ? cache.spring : cache.easing) }

// ── Bézier graph ─────────────────────────────────────────────────────────────
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
watch(box, (el) => { ro?.disconnect(); if (el) { measure(); ro = new ResizeObserver(measure); ro.observe(el) } }, { flush: 'post' })
onBeforeUnmount(() => { ro?.disconnect(); ro = null })

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

// ── "Ease" field: shows the live value; a draft while focused; commits on blur / Enter ──
const shown = (v: BezierEase) => formatEase(v.map((n) => +n.toFixed(2)) as BezierEase)
const editing = ref(false)
const draft = ref('')
function onTextFocus() { draft.value = shown(value.value); editing.value = true }
function onTextBlur() {
  const parsed = parseEase(draft.value)
  editing.value = false
  if (parsed) commitOnce(parsed)
}

// ── Spring graph (DialKit's SpringVisualization: grid, dashed mid-line, the played curve) ──
const SW = 256, SH = 140
const bounce = computed(() => (isSpringEase(props.ease) ? props.ease.bounce : cache.spring.bounce))
const springView = computed(() => {
  const span = Math.max(2, Math.min(4, springSettle(bounce.value)))   // in bar-lengths
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= 100; i++) { const p = (i / 100) * span; pts.push([p, springProgress(p, bounce.value)]) }
  const ys = pts.map(([, y]) => y)
  const min = Math.min(...ys), range = (Math.max(...ys) - min) || 1
  const Y = (y: number) => SH - (((y - min) / range) * SH * 0.6 + SH * 0.2)
  return {
    d: pts.map(([p, y], i) => `${i ? 'L' : 'M'} ${(p / span) * SW} ${Y(y)}`).join(' '),
    barEndX: (1 / span) * SW,
    targetY: Y(1),
  }
})

// ── Row slider (DialKit's: the whole row is the track, a fill + a thin handle) ──
const sliderEl = ref<HTMLElement | null>(null)
const sliding = ref(false)
const bounceAt = (clientX: number) => {
  const r = sliderEl.value!.getBoundingClientRect()
  const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
  return Math.round(f / 0.05) * 0.05
}
function setBounceLive(b: number) {
  const next: SpringEase = { type: 'spring', bounce: +Math.min(1, Math.max(0, b)).toFixed(2) }
  if (!easeEquals(next, props.ease)) emit('change', next)
}
function onSliderDown(e: PointerEvent) {
  if (e.button !== 0 || !sliderEl.value) return
  e.preventDefault()
  sliderEl.value.focus({ preventScroll: true })
  sliderEl.value.setPointerCapture(e.pointerId)
  sliding.value = true
  emit('start')
  setBounceLive(bounceAt(e.clientX))
}
function onSliderMove(e: PointerEvent) { if (sliding.value) setBounceLive(bounceAt(e.clientX)) }
function onSliderUp() { if (!sliding.value) return; sliding.value = false; emit('end') }
function onSliderKey(e: KeyboardEvent) {
  const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.05 : 0
  if (!d) return
  e.preventDefault()
  e.stopPropagation()
  commitOnce({ type: 'spring', bounce: +Math.min(1, Math.max(0, bounce.value + d)).toFixed(2) })
}
</script>

<template>
  <div class="flex flex-col gap-1.5" data-testid="easing-curve" :data-mode="mode">
    <!-- Graph -->
    <div v-if="mode === 'easing'" ref="box" role="group" aria-label="Bézier easing curve"
      class="relative w-full overflow-hidden rounded-lg bg-white/[0.04]"
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
        :aria-label="`Bézier handle ${h + 1}: X ${+value[h * 2]!.toFixed(2)}, Y ${+value[h * 2 + 1]!.toFixed(2)}`"
        :style="{ left: `${(graph.handles[h].x / size.w) * 100}%`, top: `${(graph.handles[h].y / size.h) * 100}%` }"
        @pointerdown="onDown($event, h)" @pointermove="onMove" @pointerup="(e) => { onMove(e); endDrag(e) }"
        @pointercancel="cancelDrag" @lostpointercapture="endDrag" @keydown="onKey($event, h)" />
    </div>
    <svg v-else :viewBox="`0 0 ${SW} ${SH}`" class="w-full rounded-lg bg-white/[0.04]" data-testid="spring-viz" aria-label="Spring curve">
      <template v-for="i in 3" :key="i">
        <line :x1="(SW / 4) * i" y1="0" :x2="(SW / 4) * i" :y2="SH" stroke="rgba(255,255,255,.07)" stroke-width="1" />
        <line x1="0" :y1="(SH / 4) * i" :x2="SW" :y2="(SH / 4) * i" stroke="rgba(255,255,255,.07)" stroke-width="1" />
      </template>
      <line x1="0" :y1="springView.targetY" :x2="SW" :y2="springView.targetY" stroke="rgba(255,255,255,.18)" stroke-width="1" stroke-dasharray="4,4" />
      <line :x1="springView.barEndX" y1="0" :x2="springView.barEndX" :y2="SH" stroke="rgba(124,156,255,.35)" stroke-width="1">
        <title>End of the bar — the spring keeps settling after it</title>
      </line>
      <path :d="springView.d" fill="none" stroke="#7c9cff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-testid="spring-path" />
    </svg>

    <!-- Type -->
    <div class="dk-row">
      <span class="dk-label">Type</span>
      <div class="relative -mr-1.5 flex p-0.5" role="radiogroup" aria-label="Transition type">
        <span class="dk-pill" :style="{ transform: `translateX(${MODES.findIndex((m) => m.v === mode) * 100}%)`, width: `calc((100% - 4px) / ${MODES.length})` }" />
        <button v-for="m in MODES" :key="m.v" type="button" role="radio" :aria-checked="mode === m.v" :data-testid="`ease-mode-${m.v}`"
          class="relative z-[1] w-[58px] cursor-pointer py-1 text-center text-[11px] font-medium transition-colors"
          :class="mode === m.v ? 'text-white/90' : 'text-white/45 hover:text-white/70'"
          @click="setMode(m.v)">{{ m.l }}</button>
      </div>
    </div>

    <!-- Easing: bézier coordinates -->
    <div v-if="mode === 'easing'" class="dk-row">
      <span class="dk-label">Ease</span>
      <input type="text" spellcheck="false" aria-label="Bézier coordinates" data-testid="easing-text"
        class="min-w-0 flex-1 bg-transparent text-right tabular-nums text-white/85 outline-none placeholder:text-white/30"
        :value="editing ? draft : shown(value)"
        @input="draft = ($event.target as HTMLInputElement).value"
        @focus="onTextFocus" @blur="onTextBlur"
        @keydown.enter.prevent="($event.target as HTMLInputElement).blur()">
    </div>

    <div v-if="mode === 'easing'" class="dk-row">
      <span class="dk-label">Preset</span>
      <select class="cursor-pointer bg-transparent text-right text-white/85 outline-none" aria-label="Easing preset"
        data-testid="easing-preset" :value="presetIndex" @change="onPreset">
        <option v-if="presetIndex < 0" :value="-1" disabled>Custom</option>
        <option v-for="(p, i) in PRESETS" :key="p.l" :value="i" class="bg-[#1a1a1a]">{{ p.l }}</option>
      </select>
    </div>

    <!-- Spring: bounce -->
    <div v-else ref="sliderEl" class="dk-slider" role="slider" tabindex="0" data-owns-keys data-testid="spring-bounce"
      aria-label="Bounce" aria-valuemin="0" aria-valuemax="1" :aria-valuenow="bounce" :data-active="sliding ? 'true' : undefined"
      @pointerdown="onSliderDown" @pointermove="onSliderMove" @pointerup="onSliderUp" @pointercancel="onSliderUp"
      @lostpointercapture="onSliderUp" @keydown="onSliderKey">
      <span class="dk-fill" :style="{ width: `${bounce * 100}%` }" />
      <span class="dk-handle" :style="{ left: `clamp(4px, ${bounce * 100}%, calc(100% - 7px))` }" />
      <span class="dk-label relative">Bounce</span>
      <span class="relative tabular-nums text-white/70">{{ bounce.toFixed(2) }}</span>
    </div>
  </div>
</template>

<style scoped>
/* DialKit's labelled row + row-slider geometry, in the compositor's palette. */
.dk-row, .dk-slider {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 32px;
  padding: 2px 10px 2px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  font-size: 11px;
}
.dk-label { flex-shrink: 0; font-weight: 500; color: rgba(255, 255, 255, 0.5); }
.dk-pill {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  transition: transform 0.2s cubic-bezier(0.25, 1, 0.5, 1);
  pointer-events: none;
}
.dk-slider {
  position: relative;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  outline: none;
}
.dk-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: rgba(255, 255, 255, 0.08);
  transition: background 0.15s;
  pointer-events: none;
}
.dk-slider:hover .dk-fill, .dk-slider[data-active] .dk-fill, .dk-slider:focus-visible .dk-fill { background: rgba(124, 156, 255, 0.22); }
.dk-handle {
  position: absolute;
  top: 50%;
  width: 3px;
  height: 18px;
  margin-top: -9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.85);
  pointer-events: none;
}
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
  background: #141416;
}
.ease-handle:hover::after,
.ease-handle:focus-visible::after,
.ease-handle[data-dragging]::after {
  border-color: #7c9cff;
  background: #7c9cff;
}
.ease-handle[data-dragging] { cursor: grabbing; z-index: 1; }
@media (prefers-reduced-motion: reduce) { .dk-pill { transition: none; } }
</style>
