<script setup lang="ts">
/** Transition editor for one motionx ease — a port of DialKit's TransitionControl (MIT,
 *  joshpuckett/dialkit) in Sailor's skin: the graph on top, then the app's own Studio
 *  controls — a Type switch (Easing / Spring), and either the bézier "Ease" field or the
 *  spring's Bounce row. Each mode remembers its last value, so switching back restores it.
 *  The bézier graph keeps DialKit's fitting + drag + keyboard maths; the spring graph draws
 *  exactly what plays. DialKit's third mode (Physics: stiffness/damping/mass) is left out on
 *  purpose — its length is emergent, which fights a band whose bar IS the duration.
 *  A gesture is ONE edit: `start` on grab, `change` while moving, `end` on release. */
import type { Ease, BezierEase, SpringEase, StepsEase } from '~/lib/motionx'
import { easeToBezier, easeEquals, isSpringEase, isStepsEase, springProgress, springSettle } from '~/lib/motionx/ease'
import {
  fitEasingGraph, moveEasingHandle, easingGuideEnd, easingHandleFromKey, normalizeEase,
  parseEase, formatEase, type GraphPoint,
} from '~/lib/motionx/easingGraph'
import { NO_RUN, openRun, closeRun, takeRecord, type UndoRun } from '~/lib/motionx/undoCoalesce'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSegmentedRow from '~/components/vue-canvas/studio/StudioSegmentedRow.vue'

const props = defineProps<{ ease: Ease }>()
const emit = defineEmits<{ start: []; change: [ease: Ease]; end: [] }>()

type Mode = 'easing' | 'spring' | 'steps'
const MODE_OPTIONS = ['easing', 'spring', 'steps']
const MODE_LABELS = ['Easing', 'Spring', 'Steps']
const mode = computed<Mode>(() => (isSpringEase(props.ease) ? 'spring' : isStepsEase(props.ease) ? 'steps' : 'easing'))

// Per-mode memory (DialKit caches each mode so switching back restores previous edits).
const cache = reactive<{ easing: Ease; spring: SpringEase; steps: StepsEase }>({
  easing: isSpringEase(props.ease) || isStepsEase(props.ease) ? 'easeInOut' : props.ease,
  spring: isSpringEase(props.ease) ? props.ease : { type: 'spring', bounce: 0.2 },
  steps: isStepsEase(props.ease) ? props.ease : { type: 'steps', count: 6 },
})
watch(() => props.ease, (e) => {
  if (isSpringEase(e)) cache.spring = e
  else if (isStepsEase(e)) cache.steps = e
  else cache.easing = e
}, { immediate: true })

// Quick picks, as one more labelled row (DialKit has none; the named eases are Sailor's).
const PRESETS: Array<{ l: string; v: Ease }> = [
  { l: 'Linear', v: 'linear' }, { l: 'Ease in', v: 'easeIn' }, { l: 'Ease out', v: 'easeOut' },
  { l: 'Smooth', v: 'easeInOut' }, { l: 'Overshoot', v: [0.34, 1.56, 0.64, 1] }, { l: 'Anticipate', v: [0.36, 0, 0.66, -0.56] },
]
const presetIndex = computed(() => PRESETS.findIndex((p) => easeEquals(p.v, props.ease)))
// The row models the preset by NAME. A hand-dragged curve matches none of them, so the list
// grows a "Custom" entry to have something true to show — it is never chosen, only shown.
const CUSTOM = 'Custom'
const presetOptions = computed(() =>
  (presetIndex.value < 0 ? [CUSTOM] : []).concat(PRESETS.map((p) => p.l)))
const presetValue = computed(() => (presetIndex.value < 0 ? CUSTOM : PRESETS[presetIndex.value]!.l))
function onPreset(name: string) {
  const p = PRESETS.find((x) => x.l === name)
  if (p) commitOnce(p.v)
}

function commitOnce(next: Ease) {
  if (easeEquals(next, props.ease)) return
  emit('start'); emit('change', next); emit('end')
}
function setMode(m: Mode) {
  if (m === mode.value) return
  commitOnce(m === 'spring' ? cache.spring : m === 'steps' ? cache.steps : cache.easing)
}

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

// ── Bounce / Steps, on the shared Studio row ─────────────────────────────────
// The row emits a value per pixel of a drag, and upstream `start` IS an undo step, so the
// gesture has to be folded into one: pointerdown/keydown open a run, the FIRST change in it
// emits `start`, and the release emits `end`. Lazy on purpose — a press that changes nothing
// must not leave an empty step behind. Outside a gesture (typed value, double-click reset)
// a change is complete on its own, which is exactly `commitOnce`. Bounce and Steps never show
// at once (one mode at a time), so they share one run.
let run: UndoRun = NO_RUN
const BOUNCE = 'bounce'
const STEPS = 'steps'
function endGesture() {
  if (run.recorded) emit('end')
  run = closeRun()
}
function commitGesture(key: string, next: Ease) {
  if (easeEquals(next, props.ease)) return
  if (run.key === null) { commitOnce(next); return }
  const t = takeRecord(run, key)
  run = t.run
  if (t.record) emit('start')
  emit('change', next)
}
// `data-owns-keys`: the row's track is arrow-keyable, and the modal nudges the selected
// layer on the same keys unless the focused control claims them — as the hand-rolled
// slider this replaces did.
const gestureHandlers = (key: string) => ({
  'data-owns-keys': '',
  onPointerdown: () => { run = openRun(run, key) },
  onKeydown: () => { run = openRun(run, key) },
  onPointerup: endGesture,
  onPointercancel: endGesture,
  onLostpointercapture: endGesture,
  onKeyup: endGesture,
})
const bounceGesture = gestureHandlers(BOUNCE)
const stepsGesture = gestureHandlers(STEPS)
function setBounce(b: number) {
  commitGesture(BOUNCE, { type: 'spring', bounce: +Math.min(1, Math.max(0, b)).toFixed(2) })
}
const stepsCount = computed(() => (isStepsEase(props.ease) ? props.ease.count : cache.steps.count))
function setSteps(n: number) {
  commitGesture(STEPS, { type: 'steps', count: Math.round(n) })
}

// ── Steps graph (shares the spring graph's SVG frame: same grid, no handles) ─────────────────
const stepsCountClamped = computed(() => Math.min(64, Math.max(1, Math.round(
  Number.isFinite(stepsCount.value) ? stepsCount.value : 6))))
const stepsView = computed(() => {
  const n = stepsCountClamped.value
  const X = (p: number) => p * SW
  const Y = (v: number) => SH - (v * SH * 0.6 + SH * 0.2)
  const d: string[] = [`M ${X(0)} ${Y(0)}`]
  for (let i = 0; i < n; i++) {
    const from = i / n, to = (i + 1) / n
    d.push(`L ${X(to)} ${Y(from)}`, `L ${X(to)} ${Y(to)}`)   // hold, then jump
  }
  return { d: d.join(' ') }
})
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
    <svg v-else-if="mode === 'spring'" :viewBox="`0 0 ${SW} ${SH}`" class="w-full rounded-lg bg-white/[0.04]" data-testid="spring-viz" aria-label="Spring curve">
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
    <svg v-else :viewBox="`0 0 ${SW} ${SH}`" class="w-full rounded-lg bg-white/[0.04]" data-testid="steps-viz" aria-label="Step curve">
      <template v-for="i in 3" :key="i">
        <line :x1="(SW / 4) * i" y1="0" :x2="(SW / 4) * i" :y2="SH" stroke="rgba(255,255,255,.07)" stroke-width="1" />
        <line x1="0" :y1="(SH / 4) * i" :x2="SW" :y2="(SH / 4) * i" stroke="rgba(255,255,255,.07)" stroke-width="1" />
      </template>
      <path :d="stepsView.d" fill="none" stroke="#7c9cff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-testid="steps-path" />
    </svg>

    <!-- Type -->
    <StudioSegmentedRow label="Type"
      data-testid="ease-mode" :model-value="mode" :options="MODE_OPTIONS" :option-labels="MODE_LABELS"
      @update:model-value="(v) => setMode(v as Mode)" />

    <!-- Easing: bézier coordinates. The one control here that is NOT a Studio row — four
         numbers typed as one string — so it borrows the row's geometry instead. Steps has no
         curve to describe this way, so both this field and the Preset menu below stay hidden. -->
    <div v-if="mode === 'easing'"
      class="flex h-7 items-center justify-between gap-3 rounded-[6px] bg-white/[0.05] px-2.5">
      <span class="shrink-0 text-[11px] text-white/72">Ease</span>
      <input type="text" spellcheck="false" aria-label="Bézier coordinates" data-testid="easing-text"
        class="min-w-0 flex-1 bg-transparent text-right text-[11px] tabular-nums text-white/90 outline-none placeholder:text-white/30"
        :value="editing ? draft : shown(value)"
        @input="draft = ($event.target as HTMLInputElement).value"
        @focus="onTextFocus" @blur="onTextBlur"
        @keydown.enter.prevent="($event.target as HTMLInputElement).blur()">
    </div>

    <StudioSelect v-if="mode === 'easing'" data-testid="easing-preset" label="Preset"
      :model-value="presetValue" :options="presetOptions" @update:model-value="onPreset" />

    <!-- Spring: bounce -->
    <StudioSlider v-if="mode === 'spring'" data-testid="spring-bounce" v-bind="bounceGesture"
      label="Bounce" :model-value="bounce" :min="0" :max="1" :step="0.05" :default="0.2"
      @update:model-value="setBounce" />

    <!-- Steps: how many jumps the move makes -->
    <StudioSlider v-if="mode === 'steps'" data-testid="ease-steps" v-bind="stepsGesture"
      label="Steps" :model-value="stepsCountClamped" :min="2" :max="24" :step="1" :default="6"
      hint="How many jumps the move makes. It holds still between them."
      @update:model-value="setSteps" />
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
  background: #141416;
}
.ease-handle:hover::after,
.ease-handle:focus-visible::after,
.ease-handle[data-dragging]::after {
  border-color: #7c9cff;
  background: #7c9cff;
}
.ease-handle[data-dragging] { cursor: grabbing; z-index: 1; }
</style>
