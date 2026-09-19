<script setup lang="ts">
/** Contextual motion inspector (Slice 2 — right column, decision A). Edits the current band
 *  selection: a property band → its timing (start/duration) + easing + add-point; a control
 *  point → its typed value (number field / colour picker / full GradientEditor) + ease-to-next.
 *  Emits the next motionx Track[] upstream; CompositorModal persists via setMotion. */
import type { Track, Ease, PropertyValue, StoredBehaviour, Timing } from '~/lib/motionx'

export type BehaviourPatch = { params?: Record<string, unknown>; timing?: Partial<Timing>; kind?: string }
import { trackSpan, behaviourLabel } from '~/lib/motionx/bands'
import { retimeTrack, addPoint, setPointValue, setPointEase, removePoint, setBandTrack, bandTrackAt } from '~/lib/motionx/bandEdit'
import { isTextBehaviour, pieceRanks, pieceTiming, type Order } from '~/lib/motionx/text'
import GradientEditor from '~/components/vue-canvas/compositor/GradientEditor.vue'
import MotionEasingCurve from '~/components/vue-canvas/compositor/MotionEasingCurve.vue'
import type { Gradient } from '~/lib/compositor/paint'

export interface MotionSelection { kind: 'band' | 'point' | 'behaviour' | 'legacy'; path: string; index?: number }

const props = defineProps<{
  motionx: Track[]
  behaviours?: StoredBehaviour[]
  selection: MotionSelection | null
  duration: number
  t: number | null
  label?: string
  legacyLabel?: string
  /** Letter/word/line counts of the selected TEXT layer — lets the Text section show how long
   *  each piece runs for. Undefined (non-text layer, or the modal hasn't computed it) hides that line. */
  pieceCounts?: { letters: number; words: number; lines: number }
}>()
const emit = defineEmits<{
  'update:motionx': [tracks: Track[]]
  'before-change': []
  commit: []
  'select-point': [sel: { path: string; index: number }]
  clear: []
  'behaviour-change': [id: string, patch: BehaviourPatch, record?: boolean]
  'behaviour-open': [id: string]
  'behaviour-delete': [id: string]
  'legacy-remove': [layerId: string]
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
// The curve shown for a behaviour: its own override, else what its kind compiled to.
const behEase = computed<Ease>(() => {
  const own = behParam('ease') as Ease | undefined
  if (own) return own
  const compiled = props.motionx.find((t) => t.behaviourId === behaviour.value?.id)
  return compiled?.keyframes[0]?.ease ?? 'easeInOut'
})
// Live during a handle drag: `before-change` already recorded the undo step on grab.
function setBehEaseLive(e: Ease) {
  if (behaviour.value) emit('behaviour-change', behaviour.value.id, { params: { ease: e } }, false)
}
const SLIDE_DIRS: Array<{ v: string; l: string }> = [
  { v: 'up', l: 'Up' }, { v: 'down', l: 'Down' }, { v: 'left', l: 'Left' }, { v: 'right', l: 'Right' },
]

// ── Letter behaviours (Task 5) ───────────────────────────────────────────────
const isTextBeh = computed(() => behaviour.value != null && isTextBehaviour(behaviour.value))
const BY_OPTIONS: Array<{ v: string; l: string }> = [
  { v: 'letters', l: 'Letters' }, { v: 'words', l: 'Words' }, { v: 'lines', l: 'Lines' },
]
const ORDER_OPTIONS: Array<{ v: string; l: string }> = [
  { v: 'ltr', l: 'Left to right' }, { v: 'rtl', l: 'Right to left' },
  { v: 'center', l: 'From the centre' }, { v: 'edges', l: 'From the edges' }, { v: 'random', l: 'Random' },
]
const CASCADE_STYLE_OPTIONS: Array<{ v: string; l: string }> = [
  { v: 'fade', l: 'Fade' }, { v: 'rise', l: 'Rise' }, { v: 'drop', l: 'Drop' }, { v: 'grow', l: 'Grow' }, { v: 'spin', l: 'Spin' },
]
const MASK_FROM_OPTIONS: Array<{ v: string; l: string }> = [
  { v: 'up', l: 'Slides up' }, { v: 'down', l: 'Slides down' }, { v: 'left', l: 'Slides left' }, { v: 'right', l: 'Slides right' },
]
const SCRAMBLE_MODE_OPTIONS: Array<{ v: string; l: string }> = [
  { v: 'settle', l: 'Settle' }, { v: 'scatter', l: 'Scatter' }, { v: 'loop', l: 'Keep going' },
]
// A number field must never send NaN — an emptied input sends the behaviour's own default.
function numOrDefault(raw: string, d: number): number {
  const n = Number(raw)
  return Number.isFinite(n) ? n : d
}
// Reads a numeric param straight from storage (not an input string) with its own default.
function numParam(k: string, d: number): number {
  const v = behParam(k)
  return typeof v === 'number' && Number.isFinite(v) ? v : d
}
const clampPct = (n: number) => Math.max(0, Math.min(100, n))
const cascadeAmountDefault = computed(() => {
  const style = (behParam('style') as string) ?? 'rise'
  return style === 'grow' ? 0 : style === 'spin' ? 90 : 0.6
})
const cascadeAmountLabel = computed(() => {
  const style = (behParam('style') as string) ?? 'rise'
  if (style === 'grow') return 'Start size'
  if (style === 'spin') return 'Degrees'
  return 'Distance (letter heights)'
})
const showShuffle = computed(() => {
  const beh = behaviour.value
  if (!beh) return false
  return ((behParam('order') as string) ?? 'ltr') === 'random' || beh.kind === 'text.scramble'
})
function shuffleSeed() {
  // Authoring click only — never reachable from rendering.
  setBehParams({ seed: Math.floor(Math.random() * 9999) + 1 })
}
const piecesForBy = computed<number | null>(() => {
  const counts = props.pieceCounts
  if (!counts) return null
  const by = (behParam('by') as string) ?? 'letters'
  return by === 'words' ? counts.words : by === 'lines' ? counts.lines : counts.letters
})
const pieceTimingInfo = computed(() => {
  const beh = behaviour.value
  const count = piecesForBy.value
  if (!beh || count == null) return null
  const order = ((behParam('order') as string) ?? 'ltr') as Order
  const seed = numParam('seed', 1)
  const stagger = numParam('stagger', 0.04)
  const ranks = pieceRanks(count, order, seed)
  return pieceTiming(ranks, stagger, beh.timing.duration)
})
const pieceLine = computed(() => {
  if (!pieceTimingInfo.value) return null
  const by = (behParam('by') as string) ?? 'letters'
  const prefix = by === 'lines' ? 'About each' : 'Each'
  return `${prefix} piece runs for ${pieceTimingInfo.value.pieceDur.toFixed(2)}s.`
})
const staggerShortened = computed(() => {
  if (!pieceTimingInfo.value) return false
  const stagger = numParam('stagger', 0.04)
  return pieceTimingInfo.value.staggerUsed < stagger - 1e-6
})

const track = computed<Track | null>(() =>
  props.selection ? (bandTrackAt(props.motionx, props.selection!.path) ?? null) : null)
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
// ── Easing (curve editor) ────────────────────────────────────────────────────
// A handle drag is ONE undo step: before-change on grab, live updates while it moves,
// commit on release. A point eases the segment AFTER it, so the last point has no curve.
const isLastPoint = computed(() =>
  !!track.value && props.selection?.index === track.value.keyframes.length - 1)
function applyLive(next: Track) {
  if (track.value) emit('update:motionx', setBandTrack(props.motionx, track.value.path, next))
}
function setAllEaseLive(e: Ease) {
  if (!track.value) return
  applyLive({ ...track.value, keyframes: track.value.keyframes.map((k) => ({ ...k, ease: e })) })
}
function setEaseLive(e: Ease) {
  const i = props.selection?.index
  if (track.value && i != null) applyLive(setPointEase(track.value, i, e))
}
// ── Point value / ease ───────────────────────────────────────────────────────
function setValue(v: PropertyValue) {
  const i = props.selection?.index
  if (!track.value || i == null) return
  apply(setPointValue(track.value, i, v))
}
function deleteBand() {
  if (!track.value) return
  emit('before-change')
  emit('update:motionx', setBandTrack(props.motionx, track.value.path, null))
  emit('commit')
  emit('clear')
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
  <!-- An older In/Loop/Out layer animation selected: explain it, offer removal (Task 5) -->
  <div v-if="selection?.kind === 'legacy'" data-testid="motion-inspector"
    class="rounded-lg border border-white/10 bg-[#0e0e10]/80 px-3 py-2.5 text-[11px] text-white/70">
    <div class="mb-2 flex items-center justify-between border-b border-white/10 pb-2">
      <span class="font-medium text-white/85">Older animation</span>
      <button class="cursor-pointer text-white/40 hover:text-white/80" @click="emit('clear')">Done</button>
    </div>
    <p class="mb-1 text-white/85">{{ legacyLabel }}</p>
    <p class="mb-3 leading-snug text-white/50">This was made with the older animation tools. It still plays exactly as before, but it can't be edited on this timeline. Remove it to animate this layer with behaviours instead.</p>
    <button type="button" data-testid="legacy-remove"
      class="rounded border border-white/15 px-2 py-0.5 text-white/70 hover:border-rose-400/60 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer"
      @click="emit('legacy-remove', selection.path)">Remove animation</button>
  </div>

  <!-- Behaviour band selected: kind params + timing + Open into keyframes -->
  <div v-else-if="behaviour" data-testid="motion-inspector"
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
        <input v-scrubnum type="number" step="0.01" min="0" max="1" :value="(behParam('distance') as number) ?? 0.15" title="Fraction of the frame (0–1)"
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
    <template v-else-if="isTextBeh">
      <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">Text</div>
      <div class="mb-2 flex items-center justify-between">Animate by
        <span data-testid="letters-by" class="inline-flex overflow-hidden rounded border border-white/15">
          <button v-for="o in BY_OPTIONS" :key="o.v" type="button" :data-value="o.v" class="px-2 py-0.5 cursor-pointer"
            :class="(behParam('by') ?? 'letters') === o.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
            @click="setBehParams({ by: o.v })">{{ o.l }}</button>
        </span>
      </div>
      <div class="mb-2 flex items-center justify-between">Stagger
        <input v-scrubnum type="number" step="0.01" min="0" data-testid="letters-stagger" title="Seconds between one piece starting and the next"
          :value="numParam('stagger', 0.04)"
          class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
          @change="setBehParams({ stagger: Math.max(0, numOrDefault(($event.target as HTMLInputElement).value, 0.04)) })"></div>
      <div class="mb-2 flex items-center justify-between">Order
        <select data-testid="letters-order" :value="(behParam('order') as string) ?? 'ltr'"
          class="bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none cursor-pointer"
          @change="setBehParams({ order: ($event.target as HTMLSelectElement).value })">
          <option v-for="o in ORDER_OPTIONS" :key="o.v" :value="o.v">{{ o.l }}</option>
        </select>
      </div>
      <div v-if="showShuffle" class="mb-2 flex items-center justify-end">
        <button type="button" data-testid="letters-shuffle"
          class="rounded border border-white/15 px-2 py-0.5 text-white/70 hover:bg-white/10 cursor-pointer"
          title="Pick a new random order" @click="shuffleSeed">Shuffle</button>
      </div>
      <div v-if="pieceLine" data-testid="letters-piece-time" class="mb-2 leading-snug text-white/50">
        {{ pieceLine }}<span v-if="staggerShortened"> Stagger shortened to fit the bar.</span>
      </div>

      <template v-if="behaviour.kind === 'text.cascade'">
        <div class="mb-2 flex items-center justify-between">Direction
          <span data-testid="cascade-dir" class="inline-flex overflow-hidden rounded border border-white/15">
            <button v-for="d in [{v:'in',l:'In'},{v:'out',l:'Out'}]" :key="d.v" type="button" :data-value="d.v" class="px-2 py-0.5 cursor-pointer"
              :class="(behParam('dir') ?? 'in') === d.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
              @click="setBehParams({ dir: d.v })">{{ d.l }}</button>
          </span>
        </div>
        <div class="mb-2 flex items-center justify-between">Style
          <span data-testid="cascade-style" class="inline-flex overflow-hidden rounded border border-white/15">
            <button v-for="s in CASCADE_STYLE_OPTIONS" :key="s.v" type="button" :data-value="s.v" class="px-2 py-0.5 cursor-pointer"
              :class="(behParam('style') ?? 'rise') === s.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
              @click="setBehParams({ style: s.v })">{{ s.l }}</button>
          </span>
        </div>
        <div v-if="((behParam('style') as string) ?? 'rise') !== 'fade'" class="mb-2 flex items-center justify-between">{{ cascadeAmountLabel }}
          <input v-scrubnum type="number" step="0.01" data-testid="cascade-amount"
            :value="numParam('amount', cascadeAmountDefault)"
            class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
            @change="setBehParams({ amount: numOrDefault(($event.target as HTMLInputElement).value, cascadeAmountDefault) })"></div>
      </template>
      <template v-else-if="behaviour.kind === 'text.typewriter'">
        <div class="mb-2 flex items-center justify-between">Direction
          <span data-testid="typewriter-dir" class="inline-flex overflow-hidden rounded border border-white/15">
            <button v-for="d in [{v:'type',l:'Type'},{v:'delete',l:'Delete'}]" :key="d.v" type="button" :data-value="d.v" class="px-2 py-0.5 cursor-pointer"
              :class="(behParam('dir') ?? 'type') === d.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
              @click="setBehParams({ dir: d.v })">{{ d.l }}</button>
          </span>
        </div>
        <div class="mb-2 flex items-center justify-between">Cursor
          <span data-testid="typewriter-cursor" class="inline-flex overflow-hidden rounded border border-white/15">
            <button v-for="c in [{v:'none',l:'None'},{v:'bar',l:'Bar'},{v:'underscore',l:'Underscore'}]" :key="c.v" type="button" :data-value="c.v" class="px-2 py-0.5 cursor-pointer"
              :class="(behParam('cursor') ?? 'bar') === c.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
              @click="setBehParams({ cursor: c.v })">{{ c.l }}</button>
          </span>
        </div>
        <div class="mb-2 flex items-center justify-between">Blink (per second)
          <input v-scrubnum type="number" step="0.1" min="0" data-testid="typewriter-blink"
            :value="numParam('blink', 0)"
            class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
            @change="setBehParams({ blink: Math.max(0, numOrDefault(($event.target as HTMLInputElement).value, 0)) })"></div>
      </template>
      <template v-else-if="behaviour.kind === 'text.maskSlide'">
        <div class="mb-2 flex items-center justify-between">Direction
          <span data-testid="mask-dir" class="inline-flex overflow-hidden rounded border border-white/15">
            <button v-for="d in [{v:'reveal',l:'Reveal'},{v:'hide',l:'Hide'}]" :key="d.v" type="button" :data-value="d.v" class="px-2 py-0.5 cursor-pointer"
              :class="(behParam('dir') ?? 'reveal') === d.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
              @click="setBehParams({ dir: d.v })">{{ d.l }}</button>
          </span>
        </div>
        <div class="mb-2 flex items-center justify-between">Travel
          <span data-testid="mask-from" class="inline-flex overflow-hidden rounded border border-white/15">
            <button v-for="f in MASK_FROM_OPTIONS" :key="f.v" type="button" :data-value="f.v" class="px-2 py-0.5 cursor-pointer"
              :class="(behParam('from') ?? 'up') === f.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
              @click="setBehParams({ from: f.v })">{{ f.l }}</button>
          </span>
        </div>
      </template>
      <template v-else-if="behaviour.kind === 'text.scramble'">
        <div class="mb-2 flex items-center justify-between">Mode
          <span data-testid="scramble-mode" class="inline-flex overflow-hidden rounded border border-white/15">
            <button v-for="m in SCRAMBLE_MODE_OPTIONS" :key="m.v" type="button" :data-value="m.v" class="px-2 py-0.5 cursor-pointer"
              :class="(behParam('mode') ?? 'settle') === m.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
              @click="setBehParams({ mode: m.v })">{{ m.l }}</button>
          </span>
        </div>
        <div class="mb-2 flex items-center justify-between">Area width %
          <input v-scrubnum type="number" step="1" min="0" max="100" data-testid="scramble-area-w" title="Percent of the frame width"
            :value="Math.round(numParam('areaW', 0.6) * 100)"
            class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
            @change="setBehParams({ areaW: clampPct(numOrDefault(($event.target as HTMLInputElement).value, 60)) / 100 })"></div>
        <div class="mb-2 flex items-center justify-between">Area height %
          <input v-scrubnum type="number" step="1" min="0" max="100" data-testid="scramble-area-h" title="Percent of the frame height"
            :value="Math.round(numParam('areaH', 0.6) * 100)"
            class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
            @change="setBehParams({ areaH: clampPct(numOrDefault(($event.target as HTMLInputElement).value, 60)) / 100 })"></div>
        <div class="mb-2 flex items-center justify-between">Time per jump
          <input v-scrubnum type="number" step="0.01" min="0.03" data-testid="scramble-interval" title="Seconds between jumps"
            :value="numParam('interval', 0.18)"
            class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
            @change="setBehParams({ interval: Math.max(0.03, numOrDefault(($event.target as HTMLInputElement).value, 0.18)) })"></div>
        <div class="mb-2 flex items-center justify-between">Move
          <span data-testid="scramble-move" class="inline-flex overflow-hidden rounded border border-white/15">
            <button v-for="mv in [{v:'snap',l:'Snap'},{v:'glide',l:'Glide'}]" :key="mv.v" type="button" :data-value="mv.v" class="px-2 py-0.5 cursor-pointer"
              :class="(behParam('move') ?? 'snap') === mv.v ? 'bg-[#7c9cff] text-black font-medium' : 'text-white/55 hover:text-white/85'"
              @click="setBehParams({ move: mv.v })">{{ mv.l }}</button>
          </span>
        </div>
        <div class="mb-2 flex items-center justify-between">Spin (degrees)
          <input v-scrubnum type="number" step="1" min="0" max="180" data-testid="scramble-spin"
            :value="numParam('spin', 0)"
            class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
            @change="setBehParams({ spin: Math.min(180, Math.max(0, numOrDefault(($event.target as HTMLInputElement).value, 0))) })"></div>
      </template>
    </template>

    <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">Easing</div>
    <MotionEasingCurve class="mb-2" :ease="behEase"
      @start="emit('before-change')" @change="setBehEaseLive" @end="emit('commit')" />

    <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">Timing</div>
    <div class="mb-2 flex items-center gap-3">
      <label class="flex items-center gap-1">Start
        <input v-scrubnum type="number" step="0.1" min="0" :value="+behaviour.timing.start.toFixed(2)" data-testid="beh-start"
          class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
          @change="setBehTiming({ start: Number(($event.target as HTMLInputElement).value) || 0 })"></label>
      <label class="flex items-center gap-1" :title="behaviour.timing.loop ? 'Length of one cycle — it repeats to the end of the timeline' : ''">{{ behaviour.timing.loop ? 'Cycle' : 'Duration' }}
        <input v-scrubnum type="number" step="0.1" min="0.05" :value="+behaviour.timing.duration.toFixed(2)" data-testid="beh-duration"
          class="w-16 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
          @change="setBehTiming({ duration: Math.max(0.05, Number(($event.target as HTMLInputElement).value) || 0.05) })"></label>
    </div>
    <label v-if="!isTextBeh" class="mb-2 flex items-center justify-between">Loop
      <input type="checkbox" class="accent-[#7c9cff]" :checked="behaviour.timing.loop ?? false"
        @change="setBehTiming({ loop: ($event.target as HTMLInputElement).checked })"></label>

    <div class="mt-2 flex items-center justify-between border-t border-white/10 pt-2">
      <button type="button" data-testid="beh-delete"
        class="rounded border border-white/15 px-2 py-0.5 text-white/70 hover:border-rose-400/60 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer"
        title="Remove this behaviour (Delete)" @click="emit('behaviour-delete', behaviour.id)">Delete</button>
      <button v-if="!isTextBeh" type="button" data-testid="beh-open"
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
        <input v-scrubnum type="number" step="0.01" :value="+point.value.toFixed(3)" data-testid="inspector-number"
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
      <template v-if="!isLastPoint">
        <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">Ease to next point</div>
        <MotionEasingCurve class="mb-2" :ease="point.ease"
          @start="emit('before-change')" @change="setEaseLive" @end="emit('commit')" />
      </template>
      <button type="button" class="mt-1 rounded border border-white/15 px-2 py-0.5 text-white/70 hover:border-rose-400/60 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer"
        title="Remove this control point (Delete)" @click="deletePoint">Delete point</button>
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
      <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">{{ track.keyframes.length > 2 ? 'Easing (all points)' : 'Easing' }}</div>
      <MotionEasingCurve class="mb-2" :ease="track.keyframes[0]?.ease ?? 'linear'"
        @start="emit('before-change')" @change="setAllEaseLive" @end="emit('commit')" />
      <label class="mb-2 flex items-center justify-between" title="Repeat this band to the end of the timeline — the bar is one cycle">Loop
        <input type="checkbox" class="accent-[#7c9cff]" data-testid="band-loop" :checked="!!track.loop"
          @change="apply({ ...track, loop: ($event.target as HTMLInputElement).checked })"></label>
      <div class="flex items-center justify-between">
        <span class="text-white/40">{{ track.keyframes.length }} control points</span>
        <button type="button" class="rounded border border-white/15 px-2 py-0.5 text-white/70 hover:bg-white/10 cursor-pointer"
          data-testid="inspector-add-point" @click="addAtPlayhead">＋ point</button>
      </div>
      <div class="mt-2 flex items-center justify-between border-t border-white/10 pt-2">
        <button type="button" data-testid="band-delete"
          class="rounded border border-white/15 px-2 py-0.5 text-white/70 hover:border-rose-400/60 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer"
          title="Remove this band and all its points (Delete)" @click="deleteBand">Delete band</button>
      </div>
    </template>
  </div>
</template>
