<script setup lang="ts">
/** Contextual motion inspector (Slice 2 — right column, decision A). Edits the current band
 *  selection: a property band → its timing (start/duration) + easing + add-point; a control
 *  point → its typed value (number field / colour picker / full GradientEditor) + ease-to-next.
 *  Emits the next motionx Track[] upstream; CompositorModal persists via setMotion. */
import type { Track, Ease, PropertyValue, StoredBehaviour, Timing } from '~/lib/motionx'

export type BehaviourPatch = { params?: Record<string, unknown>; timing?: Partial<Timing>; kind?: string }
import { trackSpan, behaviourLabel } from '~/lib/motionx/bands'
import { retimeTrack, addPoint, setPointValue, setPointEase, removePoint, setBandTrack } from '~/lib/motionx/bandEdit'
import GradientEditor from '~/components/vue-canvas/compositor/GradientEditor.vue'
import type { Gradient } from '~/lib/compositor/paint'

export interface MotionSelection { kind: 'band' | 'point' | 'behaviour'; path: string; index?: number }

const props = defineProps<{
  motionx: Track[]
  behaviours?: StoredBehaviour[]
  selection: MotionSelection | null
  duration: number
  t: number | null
  label?: string
}>()
const emit = defineEmits<{
  'update:motionx': [tracks: Track[]]
  'before-change': []
  commit: []
  'select-point': [sel: { path: string; index: number }]
  clear: []
  'behaviour-change': [id: string, patch: BehaviourPatch]
  'behaviour-open': [id: string]
  'behaviour-delete': [id: string]
}>()

// ── Behaviour selection (Slice 3) ────────────────────────────────────────────
const behaviour = computed<StoredBehaviour | null>(() =>
  props.selection?.kind === 'behaviour'
    ? (props.behaviours ?? []).find((b) => b.id === props.selection!.path) ?? null
    : null)
const behParam = (k: string) => behaviour.value?.params?.[k]
function setBehParams(patch: Record<string, unknown>) {
  if (behaviour.value) emit('behaviour-change', behaviour.value.id, { params: patch })
}
function setBehTiming(patch: { start?: number; duration?: number; loop?: boolean }) {
  if (behaviour.value) emit('behaviour-change', behaviour.value.id, { timing: patch })
}
const SLIDE_DIRS: Array<{ v: string; l: string }> = [
  { v: 'up', l: 'Up' }, { v: 'down', l: 'Down' }, { v: 'left', l: 'Left' }, { v: 'right', l: 'Right' },
]

const EASES: Array<{ v: Ease; l: string }> = [
  { v: 'linear', l: 'Linear' }, { v: 'easeIn', l: 'In' }, { v: 'easeOut', l: 'Out' }, { v: 'easeInOut', l: 'Smooth' },
]

const track = computed<Track | null>(() =>
  props.selection ? (props.motionx.find((t) => t.path === props.selection!.path) ?? null) : null)
const span = computed(() => (track.value ? trackSpan(track.value) : { start: 0, end: 0 }))
const point = computed(() => {
  const i = props.selection?.index
  return props.selection?.kind === 'point' && track.value && i != null ? track.value.keyframes[i] ?? null : null
})

function apply(next: Track | null) {
  if (!track.value) return
  emit('before-change')
  emit('update:motionx', setBandTrack(props.motionx, track.value.path, next))
  emit('commit')
}
// ── Band timing ──────────────────────────────────────────────────────────────
function setStart(v: number) {
  if (!track.value) return
  apply(retimeTrack(track.value, Math.max(0, v), Math.max(v + 0.05, span.value.end)))
}
function setDuration(v: number) {
  if (!track.value) return
  apply(retimeTrack(track.value, span.value.start, span.value.start + Math.max(0.05, v)))
}
function addAtPlayhead() {
  if (!track.value) return
  const res = addPoint(track.value, props.t ?? span.value.end)
  emit('before-change')
  emit('update:motionx', setBandTrack(props.motionx, track.value.path, res.track))
  emit('commit')
  emit('select-point', { path: track.value.path, index: res.index })
}
function setAllEase(e: Ease) {
  if (!track.value) return
  apply({ ...track.value, keyframes: track.value.keyframes.map((k) => ({ ...k, ease: e })) })
}
// ── Point value / ease ───────────────────────────────────────────────────────
function setValue(v: PropertyValue) {
  const i = props.selection?.index
  if (!track.value || i == null) return
  apply(setPointValue(track.value, i, v))
}
function setEase(e: Ease) {
  const i = props.selection?.index
  if (!track.value || i == null) return
  apply(setPointEase(track.value, i, e))
}
function deletePoint() {
  const i = props.selection?.index
  if (!track.value || i == null) return
  const next = removePoint(track.value, i)
  emit('before-change')
  emit('update:motionx', setBandTrack(props.motionx, track.value.path, next.keyframes.length ? next : null))
  emit('commit')
  emit('clear')
}
// Gradient <-> colour-lib stop conversion (compositor {offset} <-> motionx {pos}).
const DEFAULT_GRADIENT: Gradient = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }
const pointGradient = computed<Gradient>(() => {
  const v = point.value?.value
  if (!Array.isArray(v)) return DEFAULT_GRADIENT
  return { type: 'linear', angle: 0, stops: (v as Array<{ pos: number; color: string }>).map((s) => ({ offset: s.pos, color: s.color })) }
})
function onGradient(g: Gradient) {
  setValue(g.stops.map((s) => ({ pos: s.offset, color: s.color })))
}
</script>

<template>
  <!-- Behaviour band selected: kind params + timing + Open into keyframes -->
  <div v-if="behaviour" data-testid="motion-inspector"
    class="rounded-lg border border-white/10 bg-[#0e0e10]/80 px-3 py-2.5 text-[11px] text-white/70">
    <div class="mb-2 flex items-center justify-between border-b border-white/10 pb-2">
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-sm" style="background:#78dcaa" />
        <span class="font-medium text-white/85">{{ behaviourLabel(behaviour) }}</span>
        <span class="text-white/35">behaviour</span>
      </div>
      <button class="cursor-pointer text-white/40 hover:text-white/80" @click="emit('clear')">Done</button>
    </div>

    <!-- kind-specific params -->
    <template v-if="behaviour.kind === 'fade'">
      <div class="mb-2 flex items-center justify-between">Direction
        <span class="inline-flex overflow-hidden rounded border border-white/15">
          <button v-for="d in [{v:'in',l:'In'},{v:'out',l:'Out'}]" :key="d.v" type="button" class="px-2 py-0.5 cursor-pointer"
            :class="(behParam('dir') ?? 'in') === d.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
            @click="setBehParams({ dir: d.v })">{{ d.l }}</button>
        </span>
      </div>
    </template>
    <template v-else-if="behaviour.kind === 'slide'">
      <div class="mb-2 flex items-center justify-between">Direction
        <span class="inline-flex overflow-hidden rounded border border-white/15">
          <button v-for="d in SLIDE_DIRS" :key="d.v" type="button" class="px-2 py-0.5 cursor-pointer"
            :class="(behParam('dir') ?? 'up') === d.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
            @click="setBehParams({ dir: d.v })">{{ d.l }}</button>
        </span>
      </div>
      <div class="mb-2 flex items-center justify-between">Distance
        <input v-scrubnum type="number" step="1" :value="(behParam('distance') as number) ?? 40"
          class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
          @change="setBehParams({ distance: Number(($event.target as HTMLInputElement).value) || 0 })"></div>
    </template>
    <template v-else-if="behaviour.kind === 'gradientMorph'">
      <div class="mb-2 flex items-center justify-between">Mode
        <span class="inline-flex overflow-hidden rounded border border-white/15">
          <button v-for="m in [{v:'crossfade',l:'Crossfade'},{v:'travel',l:'Travel'}]" :key="m.v" type="button" class="px-2 py-0.5 cursor-pointer"
            :class="(behParam('mode') ?? 'crossfade') === m.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
            @click="setBehParams({ mode: m.v })">{{ m.l }}</button>
        </span>
      </div>
      <div class="mb-2 flex items-center justify-between">Colour
        <span class="inline-flex overflow-hidden rounded border border-white/15">
          <button v-for="s in [{v:'oklab',l:'OKLab'},{v:'hybrid',l:'Hybrid'}]" :key="s.v" type="button" class="px-2 py-0.5 cursor-pointer"
            :class="(behParam('space') ?? 'oklab') === s.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
            @click="setBehParams({ space: s.v })">{{ s.l }}</button>
        </span>
      </div>
    </template>

    <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">Timing</div>
    <div class="mb-2 flex items-center gap-3">
      <label class="flex items-center gap-1">Start
        <input v-scrubnum type="number" step="0.1" min="0" :value="+behaviour.timing.start.toFixed(2)" data-testid="beh-start"
          class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
          @change="setBehTiming({ start: Number(($event.target as HTMLInputElement).value) || 0 })"></label>
      <label class="flex items-center gap-1">Duration
        <input v-scrubnum type="number" step="0.1" min="0.05" :value="+behaviour.timing.duration.toFixed(2)" data-testid="beh-duration"
          class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
          @change="setBehTiming({ duration: Math.max(0.05, Number(($event.target as HTMLInputElement).value) || 0.05) })"></label>
    </div>
    <label class="mb-2 flex items-center justify-between">Loop
      <input type="checkbox" class="accent-[#7c9cff]" :checked="behaviour.timing.loop ?? false"
        @change="setBehTiming({ loop: ($event.target as HTMLInputElement).checked })"></label>

    <div class="mt-2 flex items-center justify-between border-t border-white/10 pt-2">
      <button type="button" class="text-white/40 hover:text-rose-300 cursor-pointer" @click="emit('behaviour-delete', behaviour.id)">Delete</button>
      <button type="button" data-testid="beh-open"
        class="rounded border border-white/15 px-2 py-0.5 text-white/80 hover:bg-white/10 cursor-pointer"
        title="Bake into editable control-point bands" @click="emit('behaviour-open', behaviour.id)">Open into keyframes</button>
    </div>
  </div>

  <div v-else-if="track" data-testid="motion-inspector"
    class="rounded-lg border border-white/10 bg-[#0e0e10]/80 px-3 py-2.5 text-[11px] text-white/70">
    <!-- Header naming the selection -->
    <div class="mb-2 flex items-center justify-between border-b border-white/10 pb-2">
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-sm"
          :style="{ background: point ? '#ffd21f' : '#7c9cff' }" />
        <span class="font-medium text-white/85">{{ label || (track.path.split('.').pop()) }}</span>
        <span class="text-white/35">{{ point ? `point @ ${point.t.toFixed(2)}s` : 'band' }}</span>
      </div>
      <button class="cursor-pointer text-white/40 hover:text-white/80" @click="emit('clear')">Done</button>
    </div>

    <!-- Control-point selected: typed value editor + ease -->
    <template v-if="point">
      <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">Value</div>
      <div v-if="typeof point.value === 'number'" class="mb-2">
        <input v-scrubnum type="number" step="0.01" :value="point.value" data-testid="inspector-number"
          class="w-full bg-[#0d0d0d] border border-white/15 rounded px-2 py-1 text-white/90 outline-none"
          @change="setValue(Number(($event.target as HTMLInputElement).value) || 0)">
      </div>
      <div v-else-if="typeof point.value === 'string'" class="mb-2 flex items-center gap-2">
        <input type="color" :value="point.value" data-testid="inspector-color"
          class="w-7 h-7 rounded cursor-pointer bg-transparent border border-white/15"
          @input="setValue(($event.target as HTMLInputElement).value)">
        <span class="tabular-nums uppercase text-white/70">{{ point.value }}</span>
      </div>
      <div v-else class="mb-2">
        <GradientEditor :model-value="pointGradient" @update:model-value="onGradient" />
      </div>
      <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">Ease to next</div>
      <div class="mb-2 inline-flex overflow-hidden rounded border border-white/15">
        <button v-for="e in EASES" :key="e.v" type="button"
          class="px-2 py-0.5 cursor-pointer"
          :class="(point.ease) === e.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
          @click="setEase(e.v)">{{ e.l }}</button>
      </div>
      <button type="button" class="mt-1 text-white/40 hover:text-rose-300 cursor-pointer" @click="deletePoint">Delete point</button>
    </template>

    <!-- Property band selected: timing + easing + add point -->
    <template v-else>
      <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">Timing</div>
      <div class="mb-2 flex items-center gap-3">
        <label class="flex items-center gap-1">Start
          <input v-scrubnum type="number" step="0.1" min="0" :value="+span.start.toFixed(2)" data-testid="inspector-start"
            class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
            @change="setStart(Number(($event.target as HTMLInputElement).value) || 0)"></label>
        <label class="flex items-center gap-1">Duration
          <input v-scrubnum type="number" step="0.1" min="0.05" :value="+(span.end - span.start).toFixed(2)" data-testid="inspector-duration"
            class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
            @change="setDuration(Number(($event.target as HTMLInputElement).value) || 0.05)"></label>
      </div>
      <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">Easing (all points)</div>
      <div class="mb-2 inline-flex overflow-hidden rounded border border-white/15">
        <button v-for="e in EASES" :key="e.v" type="button" class="px-2 py-0.5 cursor-pointer text-white/55 hover:text-white/85"
          @click="setAllEase(e.v)">{{ e.l }}</button>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-white/40">{{ track.keyframes.length }} control points</span>
        <button type="button" class="rounded border border-white/15 px-2 py-0.5 text-white/70 hover:bg-white/10 cursor-pointer"
          data-testid="inspector-add-point" @click="addAtPlayhead">＋ point</button>
      </div>
    </template>
  </div>
</template>
