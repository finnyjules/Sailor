<script setup lang="ts">
/** Contextual motion inspector (Slice 2 — right column, decision A). Edits the current band
 *  selection: a property band → its timing (start/duration) + easing + add-point; a control
 *  point → its typed value (number row / colour row / full GradientEditor) + ease-to-next.
 *  Emits the next motionx Track[] upstream; CompositorModal persists via setMotion.
 *
 *  Every control here is a shared Studio control — the 28px row that IS the slider, the
 *  segmented strip, the labelled select, the switch, the button — so this panel reads like
 *  the Cloner / Feather / Fill panels it sits beside instead of like a form. */
import type { Track, Ease, PropertyValue, StoredBehaviour, Timing } from '~/lib/motionx'

export type BehaviourPatch = { params?: Record<string, unknown>; timing?: Partial<Timing>; kind?: string }
import { trackSpan, behaviourLabel } from '~/lib/motionx/bands'
import { retimeTrack, addPoint, setPointValue, setPointEase, removePoint, setBandTrack, bandTrackAt } from '~/lib/motionx/bandEdit'
import { DEFAULT_TEXT_EASE, isTextBehaviour, pieceRanks, pieceTiming, textBehaviourUsesEase, type Order } from '~/lib/motionx/text'
import { NO_RUN, openRun, closeRun, takeRecord, type UndoRun } from '~/lib/motionx/undoCoalesce'
import GradientEditor from '~/components/vue-canvas/compositor/GradientEditor.vue'
import MotionEasingCurve from '~/components/vue-canvas/compositor/MotionEasingCurve.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioColorField from '~/components/vue-canvas/studio/StudioColorField.vue'
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

// ── One drag = one undo step ─────────────────────────────────────────────────
// A Studio row emits a value per pixel of a drag and per repeat of a held arrow key, and
// every edit below records an undo step. The row does not announce a gesture, but its DOM
// does — pointerdown/keydown open one, pointerup/pointercancel/keyup close it — and those
// reach this component as plain native listeners on the control (attrs fall through to the
// row's root). `undoCoalesce` is the state machine between the two; it is LAZY, so a press
// that turns out to be a click leaves no empty undo step behind.
//
// Not a ref: nothing renders from it, and making it reactive would re-render every row of
// the panel on every pixel of a drag.
let undoRun: UndoRun = NO_RUN
function recordFor(key: string): boolean {
  const r = takeRecord(undoRun, key)
  undoRun = r.run
  return r.record
}
/**
 * Native listeners for one control, so a slider reads `v-bind="gesture('slot-steps')"`.
 *
 * `data-owns-keys` rides along because a Studio row's track IS arrow-keyable, and the
 * modal's editor shortcuts nudge the SELECTED LAYER on the same keys unless the focused
 * control claims them (CompositorModal's `onKeydown`). The number fields this replaces were
 * `<input>`s, which that handler already skipped as "typing"; without the marker, arrowing
 * Stagger would also walk the layer across the frame.
 */
function gesture(key: string) {
  return {
    'data-owns-keys': '',
    // CAPTURE phase: the row's own keydown / pointerdown handler can emit a value straight
    // away (an arrow-key nudge does), and a bubbling listener here would only hear about the
    // gesture AFTER that first value — which then recorded on its own, making a held key two
    // undo steps instead of one.
    onPointerdownCapture: () => { undoRun = openRun(undoRun, key) },
    onKeydownCapture: () => { undoRun = openRun(undoRun, key) },
    onPointerup: () => { undoRun = closeRun() },
    onPointercancel: () => { undoRun = closeRun() },
    onLostpointercapture: () => { undoRun = closeRun() },
    onKeyup: () => { undoRun = closeRun() },
  }
}

// ── Behaviour selection (Slice 3) ────────────────────────────────────────────
const behaviour = computed<StoredBehaviour | null>(() =>
  props.selection?.kind === 'behaviour'
    ? (props.behaviours ?? []).find((b) => b.id === props.selection!.path) ?? null
    : null)
const behParam = (k: string) => behaviour.value?.params?.[k]
/** A discrete edit — an option, a switch, a shuffle. Always its own undo step. */
function setBehParams(patch: Record<string, unknown>) {
  undoRun = closeRun()
  if (behaviour.value) emit('behaviour-change', behaviour.value.id, { params: patch })
}
/** A row-slider edit: the first value of a gesture records, the rest ride along. */
function setBehNum(key: string, patch: Record<string, unknown>) {
  if (behaviour.value) emit('behaviour-change', behaviour.value.id, { params: patch }, recordFor(key))
}
function setBehTiming(patch: { start?: number; duration?: number; loop?: boolean }, key?: string) {
  if (!behaviour.value) return
  if (!key) undoRun = closeRun()
  emit('behaviour-change', behaviour.value.id, { timing: patch }, key ? recordFor(key) : true)
}
// The curve shown for a behaviour: its own override, else what its kind compiled to. A
// LETTER bar compiles to no track at all — it moves glyphs, not properties — so there is no
// keyframe to read its curve off, and it falls back to the evaluator's own default instead.
const behEase = computed<Ease>(() => {
  const own = behParam('ease') as Ease | undefined
  if (own) return own
  if (behaviour.value && isTextBehaviour(behaviour.value)) return DEFAULT_TEXT_EASE
  const compiled = props.motionx.find((t) => t.behaviourId === behaviour.value?.id)
  return compiled?.keyframes[0]?.ease ?? 'easeInOut'
})
// Live during a handle drag: `before-change` already recorded the undo step on grab.
function setBehEaseLive(e: Ease) {
  if (behaviour.value) emit('behaviour-change', behaviour.value.id, { params: { ease: e } }, false)
}

// ── Option lists ─────────────────────────────────────────────────────────────
// Values are the evaluator's own enum strings (the `oneOf` lists in text/behaviours.ts);
// labels are what the user reads, paired by index the way every Studio picker pairs them.
const IN_OUT = ['in', 'out']
const IN_OUT_LABELS = ['In', 'Out']
const SLIDE_DIRS = ['up', 'down', 'left', 'right']
const SLIDE_DIR_LABELS = ['Up', 'Down', 'Left', 'Right']
const MORPH_MODES = ['crossfade', 'travel']
const MORPH_MODE_LABELS = ['Crossfade', 'Travel']
const MORPH_SPACES = ['oklab', 'hybrid']
const MORPH_SPACE_LABELS = ['OKLab', 'Hybrid']

// ── Letter behaviours (Task 5) ───────────────────────────────────────────────
const isTextBeh = computed(() => behaviour.value != null && isTextBehaviour(behaviour.value))
const BY_OPTIONS = ['letters', 'words', 'lines']
const BY_LABELS = ['Letters', 'Words', 'Lines']
const ORDER_OPTIONS = ['ltr', 'rtl', 'center', 'edges', 'random']
const ORDER_LABELS = ['Left to right', 'Right to left', 'From the centre', 'From the edges', 'Random']
const CASCADE_STYLE_OPTIONS = ['fade', 'rise', 'drop', 'grow', 'spin']
const CASCADE_STYLE_LABELS = ['Fade', 'Rise', 'Drop', 'Grow', 'Spin']
const TYPE_DIR_OPTIONS = ['type', 'delete']
const TYPE_DIR_LABELS = ['Type', 'Delete']
const CURSOR_OPTIONS = ['none', 'bar', 'underscore']
const CURSOR_LABELS = ['None', 'Bar', 'Underscore']
const MASK_DIR_OPTIONS = ['reveal', 'hide']
const MASK_DIR_LABELS = ['Reveal', 'Hide']
const MASK_FROM_OPTIONS = ['up', 'down', 'left', 'right']
const MASK_FROM_LABELS = ['Slides up', 'Slides down', 'Slides left', 'Slides right']
const SCRAMBLE_MODE_OPTIONS = ['settle', 'scatter', 'loop']
const SCRAMBLE_MODE_LABELS = ['Settle', 'Scatter', 'Keep going']
const SCRAMBLE_MOVE_OPTIONS = ['snap', 'glide']
const SCRAMBLE_MOVE_LABELS = ['Snap', 'Glide']
const DECODE_DIR_OPTIONS = ['resolve', 'dissolve']
const DECODE_DIR_LABELS = ['Resolve', 'Dissolve']
const SLOT_ROLL_OPTIONS = ['up', 'down']
const SLOT_ROLL_LABELS = ['Rolls up', 'Rolls down']
// Shared by Decode's Characters and Slot slide's Filler — the same five character pools.
const CHARSET_OPTIONS = ['text', 'letters', 'numbers', 'symbols', 'mixed']
const CHARSET_LABELS = ['Same as the text', 'Letters', 'Numbers', 'Symbols', 'Mixed']

/** Reads an enum param with the evaluator's own fallback. */
const enumParam = (k: string, d: string) => ((behParam(k) as string | undefined) ?? d)
/** Reads a numeric param straight from storage with its own default. */
function numParam(k: string, d: number): number {
  const v = behParam(k)
  return typeof v === 'number' && Number.isFinite(v) ? v : d
}
const cascadeAmountDefault = computed(() => {
  const style = enumParam('style', 'rise')
  return style === 'grow' ? 0 : style === 'spin' ? 90 : 0.6
})
const cascadeAmountLabel = computed(() => {
  const style = enumParam('style', 'rise')
  if (style === 'grow') return 'Start size'
  if (style === 'spin') return 'Degrees'
  return 'Distance (letter heights)'
})
// Three different quantities behind one param: letter heights, a scale factor, degrees.
const cascadeAmountRange = computed(() => {
  const style = enumParam('style', 'rise')
  if (style === 'grow') return { min: 0, max: 1, step: 0.05 }
  if (style === 'spin') return { min: 0, max: 360, step: 1 }
  return { min: 0, max: 3, step: 0.05 }
})
const showShuffle = computed(() => {
  const beh = behaviour.value
  if (!beh) return false
  const HASHED_KINDS = ['text.scramble', 'text.decode', 'text.slot', 'text.jitter']
  return enumParam('order', 'ltr') === 'random' || HASHED_KINDS.includes(beh.kind)
})
// Loops (wave/bounce/jitter): span the whole bar with no per-piece stagger, so Stagger and
// "each piece runs for" say nothing — they show Amount/Speed(/Offset) instead.
const isLoopBeh = computed(() => {
  const k = behaviour.value?.kind
  return k === 'text.wave' || k === 'text.bounce' || k === 'text.jitter'
})
const loopAmountDefault = computed(() => {
  const k = behaviour.value?.kind
  return k === 'text.bounce' ? 0.35 : k === 'text.jitter' ? 0.08 : 0.25
})
const loopSpeedDefault = computed(() => {
  const k = behaviour.value?.kind
  return k === 'text.bounce' ? 1.4 : k === 'text.jitter' ? 12 : 1
})
// The Easing block is dead for a kind whose curve does nothing (a hard cut, a hashed flicker,
// a loop riding its own sine) — read from the registry so this can never drift from evaluate.ts.
const showEasing = computed(() => {
  if (!behaviour.value) return false
  if (!isTextBeh.value) return true
  return textBehaviourUsesEase(behaviour.value.kind, behaviour.value.params)
})
function shuffleSeed() {
  // Authoring click only — never reachable from rendering.
  setBehParams({ seed: Math.floor(Math.random() * 9999) + 1 })
}
const piecesForBy = computed<number | null>(() => {
  const counts = props.pieceCounts
  if (!counts) return null
  const by = enumParam('by', 'letters')
  return by === 'words' ? counts.words : by === 'lines' ? counts.lines : counts.letters
})
const pieceTimingInfo = computed(() => {
  const beh = behaviour.value
  const count = piecesForBy.value
  if (!beh || count == null) return null
  const order = enumParam('order', 'ltr') as Order
  const seed = numParam('seed', 1)
  const stagger = numParam('stagger', 0.04)
  const ranks = pieceRanks(count, order, seed)
  return pieceTiming(ranks, stagger, beh.timing.duration)
})
const pieceLine = computed(() => {
  if (!pieceTimingInfo.value) return null
  const by = enumParam('by', 'letters')
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

/** The timeline's own length, as the ceiling every timing row drags against. */
const timeMax = computed(() => Math.max(0.1, props.duration || 0))

function apply(next: Track | null, key?: string) {
  if (!track.value) return
  // `before-change` IS the undo step here (the modal records on it), so a coalesced
  // gesture emits it once and the rest of the drag rides along.
  if (!key || recordFor(key)) emit('before-change')
  emit('update:motionx', setBandTrack(props.motionx, track.value.path, next))
  emit('commit')
}
// ── Band timing ──────────────────────────────────────────────────────────────
function setStart(v: number) {
  if (!track.value) return
  apply(retimeTrack(track.value, Math.max(0, v), Math.max(v + 0.05, span.value.end)), 'inspector-start')
}
function setDuration(v: number) {
  if (!track.value) return
  apply(retimeTrack(track.value, span.value.start, span.value.start + Math.max(0.05, v)), 'inspector-duration')
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
function setValue(v: PropertyValue, key?: string) {
  const i = props.selection?.index
  if (!track.value || i == null) return
  apply(setPointValue(track.value, i, v), key)
}
/**
 * The range a control point's number drags against. The five Transform properties (and the
 * gradient's scroll phase) declare theirs in the Frame adapter's `animatableProperties`;
 * this panel never sees the layer, so they are listed here, and anything else — an effect
 * dial — falls back to a range wide enough not to fence a value in.
 */
const PROPERTY_RANGE: Record<string, { min: number; max: number }> = {
  x: { min: 0, max: 1 },
  y: { min: 0, max: 1 },
  scale: { min: 0, max: 4 },
  rotation: { min: -360, max: 360 },
  opacity: { min: 0, max: 1 },
  'fill.phase': { min: 0, max: 1 },
}
const pointRange = computed(() => {
  // `layers.<id>.<property…>` — the property is everything after the id.
  const prop = (track.value?.path ?? '').split('.').slice(2).join('.')
  return PROPERTY_RANGE[prop] ?? { min: -1000, max: 1000 }
})
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
      <StudioButton variant="subtle" @click="emit('clear')">Done</StudioButton>
    </div>
    <p class="mb-1 text-white/85">{{ legacyLabel }}</p>
    <p class="mb-3 leading-snug text-white/50">This was made with the older animation tools. It still plays exactly as before, but it can't be edited on this timeline. Remove it to animate this layer with behaviours instead.</p>
    <StudioButton data-testid="legacy-remove" @click="emit('legacy-remove', selection.path)">Remove animation</StudioButton>
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
      <StudioButton variant="subtle" @click="emit('clear')">Done</StudioButton>
    </div>

    <!-- kind-specific params -->
    <div class="space-y-2">
      <template v-if="behaviour.kind === 'fade'">
        <div>
          <div class="panel-sublabel mb-1">Direction</div>
          <StudioSegmented :model-value="enumParam('dir', 'in')" :options="IN_OUT" :option-labels="IN_OUT_LABELS"
            @update:model-value="(v) => setBehParams({ dir: v })" />
        </div>
      </template>
      <template v-else-if="behaviour.kind === 'slide'">
        <div>
          <div class="panel-sublabel mb-1">Direction</div>
          <StudioSegmented :model-value="enumParam('dir', 'up')" :options="SLIDE_DIRS" :option-labels="SLIDE_DIR_LABELS"
            @update:model-value="(v) => setBehParams({ dir: v })" />
        </div>
        <StudioSlider data-testid="slide-distance" v-bind="gesture('slide-distance')"
          label="Distance" hint="Fraction of the frame (0–1)"
          :model-value="numParam('distance', 0.15)" :min="0" :max="1" :step="0.01" :default="0.15"
          @update:model-value="(v) => setBehNum('slide-distance', { distance: v })" />
      </template>
      <template v-else-if="behaviour.kind === 'gradientMorph'">
        <div>
          <div class="panel-sublabel mb-1">Mode</div>
          <StudioSegmented :model-value="enumParam('mode', 'crossfade')" :options="MORPH_MODES" :option-labels="MORPH_MODE_LABELS"
            @update:model-value="(v) => setBehParams({ mode: v })" />
        </div>
        <div>
          <div class="panel-sublabel mb-1">Colour</div>
          <StudioSegmented :model-value="enumParam('space', 'oklab')" :options="MORPH_SPACES" :option-labels="MORPH_SPACE_LABELS"
            @update:model-value="(v) => setBehParams({ space: v })" />
        </div>
      </template>
      <template v-else-if="isTextBeh">
        <div class="text-[10px] uppercase tracking-wide text-white/35">Text</div>
        <div data-testid="letters-by">
          <div class="panel-sublabel mb-1">Animate by</div>
          <StudioSegmented :model-value="enumParam('by', 'letters')" :options="BY_OPTIONS" :option-labels="BY_LABELS"
            @update:model-value="(v) => setBehParams({ by: v })" />
        </div>
        <StudioSlider v-if="!isLoopBeh" data-testid="letters-stagger" v-bind="gesture('letters-stagger')"
          label="Stagger" hint="Seconds between one piece starting and the next"
          :model-value="numParam('stagger', 0.04)" :min="0" :max="0.5" :step="0.01" :default="0.04"
          @update:model-value="(v) => setBehNum('letters-stagger', { stagger: v })" />
        <StudioSelect data-testid="letters-order" label="Order"
          :model-value="enumParam('order', 'ltr')" :options="ORDER_OPTIONS" :option-labels="ORDER_LABELS"
          @update:model-value="(v) => setBehParams({ order: v })" />
        <div v-if="showShuffle" class="flex items-center justify-end">
          <StudioButton data-testid="letters-shuffle" title="Pick a new random order" @click="shuffleSeed">Shuffle</StudioButton>
        </div>
        <div v-if="pieceLine && !isLoopBeh" data-testid="letters-piece-time" class="leading-snug text-white/50">
          {{ pieceLine }}<span v-if="staggerShortened"> Stagger shortened to fit the bar.</span>
        </div>

        <template v-if="isLoopBeh">
          <StudioSlider data-testid="loop-amount" v-bind="gesture('loop-amount')"
            label="Amount (letter heights)"
            :model-value="numParam('amount', loopAmountDefault)" :min="0" :max="1.5" :step="0.01" :default="loopAmountDefault"
            @update:model-value="(v) => setBehNum('loop-amount', { amount: v })" />
          <StudioSlider data-testid="loop-speed" v-bind="gesture('loop-speed')"
            label="Speed (per second)"
            :model-value="numParam('speed', loopSpeedDefault)" :min="0.1" :max="20" :step="0.1" :default="loopSpeedDefault"
            @update:model-value="(v) => setBehNum('loop-speed', { speed: v })" />
          <StudioSlider v-if="behaviour.kind === 'text.wave' || behaviour.kind === 'text.bounce'"
            data-testid="loop-offset" v-bind="gesture('loop-offset')"
            label="Offset between pieces (cycles)"
            :model-value="numParam('offset', 0.12)" :min="0" :max="1" :step="0.01" :default="0.12"
            @update:model-value="(v) => setBehNum('loop-offset', { offset: v })" />
        </template>

        <template v-if="behaviour.kind === 'text.cascade'">
          <div data-testid="cascade-dir">
            <div class="panel-sublabel mb-1">Direction</div>
            <StudioSegmented :model-value="enumParam('dir', 'in')" :options="IN_OUT" :option-labels="IN_OUT_LABELS"
              @update:model-value="(v) => setBehParams({ dir: v })" />
          </div>
          <StudioSelect data-testid="cascade-style" label="Style"
            :model-value="enumParam('style', 'rise')" :options="CASCADE_STYLE_OPTIONS" :option-labels="CASCADE_STYLE_LABELS"
            @update:model-value="(v) => setBehParams({ style: v })" />
          <StudioSlider v-if="enumParam('style', 'rise') !== 'fade'"
            data-testid="cascade-amount" v-bind="gesture('cascade-amount')"
            :label="cascadeAmountLabel"
            :model-value="numParam('amount', cascadeAmountDefault)"
            :min="cascadeAmountRange.min" :max="cascadeAmountRange.max" :step="cascadeAmountRange.step"
            :default="cascadeAmountDefault"
            @update:model-value="(v) => setBehNum('cascade-amount', { amount: v })" />
        </template>
        <template v-else-if="behaviour.kind === 'text.typewriter'">
          <div data-testid="typewriter-dir">
            <div class="panel-sublabel mb-1">Direction</div>
            <StudioSegmented :model-value="enumParam('dir', 'type')" :options="TYPE_DIR_OPTIONS" :option-labels="TYPE_DIR_LABELS"
              @update:model-value="(v) => setBehParams({ dir: v })" />
          </div>
          <StudioSelect data-testid="typewriter-cursor" label="Cursor"
            :model-value="enumParam('cursor', 'bar')" :options="CURSOR_OPTIONS" :option-labels="CURSOR_LABELS"
            @update:model-value="(v) => setBehParams({ cursor: v })" />
          <StudioSlider data-testid="typewriter-blink" v-bind="gesture('typewriter-blink')"
            label="Blink (per second)"
            :model-value="numParam('blink', 0)" :min="0" :max="8" :step="0.5" :default="0"
            @update:model-value="(v) => setBehNum('typewriter-blink', { blink: v })" />
        </template>
        <template v-else-if="behaviour.kind === 'text.maskSlide'">
          <div data-testid="mask-dir">
            <div class="panel-sublabel mb-1">Direction</div>
            <StudioSegmented :model-value="enumParam('dir', 'reveal')" :options="MASK_DIR_OPTIONS" :option-labels="MASK_DIR_LABELS"
              @update:model-value="(v) => setBehParams({ dir: v })" />
          </div>
          <StudioSelect data-testid="mask-from" label="Travel"
            :model-value="enumParam('from', 'up')" :options="MASK_FROM_OPTIONS" :option-labels="MASK_FROM_LABELS"
            @update:model-value="(v) => setBehParams({ from: v })" />
        </template>
        <template v-else-if="behaviour.kind === 'text.scramble'">
          <div data-testid="scramble-mode">
            <div class="panel-sublabel mb-1">Mode</div>
            <StudioSegmented :model-value="enumParam('mode', 'settle')" :options="SCRAMBLE_MODE_OPTIONS" :option-labels="SCRAMBLE_MODE_LABELS"
              @update:model-value="(v) => setBehParams({ mode: v })" />
          </div>
          <!-- Stored 0–1; shown as a percentage of the frame, exactly as before. -->
          <StudioSlider data-testid="scramble-area-w" v-bind="gesture('scramble-area-w')"
            label="Area width %" hint="Percent of the frame width"
            :model-value="Math.round(numParam('areaW', 0.6) * 100)" :min="0" :max="100" :step="1" :default="60"
            @update:model-value="(v) => setBehNum('scramble-area-w', { areaW: v / 100 })" />
          <StudioSlider data-testid="scramble-area-h" v-bind="gesture('scramble-area-h')"
            label="Area height %" hint="Percent of the frame height"
            :model-value="Math.round(numParam('areaH', 0.6) * 100)" :min="0" :max="100" :step="1" :default="60"
            @update:model-value="(v) => setBehNum('scramble-area-h', { areaH: v / 100 })" />
          <StudioSlider data-testid="scramble-interval" v-bind="gesture('scramble-interval')"
            label="Time per jump" hint="Seconds between jumps"
            :model-value="numParam('interval', 0.18)" :min="0.03" :max="1" :step="0.01" :default="0.18"
            @update:model-value="(v) => setBehNum('scramble-interval', { interval: v })" />
          <div data-testid="scramble-move">
            <div class="panel-sublabel mb-1">Move</div>
            <StudioSegmented :model-value="enumParam('move', 'snap')" :options="SCRAMBLE_MOVE_OPTIONS" :option-labels="SCRAMBLE_MOVE_LABELS"
              @update:model-value="(v) => setBehParams({ move: v })" />
          </div>
          <StudioSlider data-testid="scramble-spin" v-bind="gesture('scramble-spin')"
            label="Spin (degrees)"
            :model-value="numParam('spin', 0)" :min="0" :max="180" :step="1" :default="0"
            @update:model-value="(v) => setBehNum('scramble-spin', { spin: v })" />
        </template>
        <template v-else-if="behaviour.kind === 'text.decode'">
          <div data-testid="decode-dir">
            <div class="panel-sublabel mb-1">Direction</div>
            <StudioSegmented :model-value="enumParam('dir', 'resolve')" :options="DECODE_DIR_OPTIONS" :option-labels="DECODE_DIR_LABELS"
              @update:model-value="(v) => setBehParams({ dir: v })" />
          </div>
          <StudioSelect data-testid="decode-charset" label="Characters"
            :model-value="enumParam('charset', 'text')" :options="CHARSET_OPTIONS" :option-labels="CHARSET_LABELS"
            @update:model-value="(v) => setBehParams({ charset: v })" />
          <StudioSlider data-testid="decode-rate" v-bind="gesture('decode-rate')"
            label="Flicker rate (per second)"
            :model-value="numParam('rate', 14)" :min="1" :max="40" :step="1" :default="14"
            @update:model-value="(v) => setBehNum('decode-rate', { rate: v })" />
        </template>
        <template v-else-if="behaviour.kind === 'text.slot'">
          <div data-testid="slot-dir">
            <div class="panel-sublabel mb-1">Direction</div>
            <StudioSegmented :model-value="enumParam('dir', 'in')" :options="IN_OUT" :option-labels="IN_OUT_LABELS"
              @update:model-value="(v) => setBehParams({ dir: v })" />
          </div>
          <div data-testid="slot-roll">
            <div class="panel-sublabel mb-1">Roll</div>
            <StudioSegmented :model-value="enumParam('roll', 'up')" :options="SLOT_ROLL_OPTIONS" :option-labels="SLOT_ROLL_LABELS"
              @update:model-value="(v) => setBehParams({ roll: v })" />
          </div>
          <StudioSlider data-testid="slot-steps" v-bind="gesture('slot-steps')"
            label="Steps" hint="How many characters roll past before it lands"
            :model-value="numParam('steps', 8)" :min="1" :max="40" :step="1" :default="8"
            @update:model-value="(v) => setBehNum('slot-steps', { steps: v })" />
          <StudioSelect data-testid="slot-filler" label="Filler"
            :model-value="enumParam('filler', 'letters')" :options="CHARSET_OPTIONS" :option-labels="CHARSET_LABELS"
            @update:model-value="(v) => setBehParams({ filler: v })" />
        </template>
      </template>
    </div>

    <template v-if="showEasing">
      <div class="mb-1 mt-2 text-[10px] uppercase tracking-wide text-white/35">Easing</div>
      <MotionEasingCurve class="mb-2" :ease="behEase"
        @start="emit('before-change')" @change="setBehEaseLive" @end="emit('commit')" />
    </template>

    <div class="mb-1 mt-2 text-[10px] uppercase tracking-wide text-white/35">Timing</div>
    <div class="space-y-2">
      <StudioSlider data-testid="beh-start" v-bind="gesture('beh-start')"
        label="Start" :model-value="+behaviour.timing.start.toFixed(2)" :min="0" :max="timeMax" :step="0.05" :default="0"
        @update:model-value="(v) => setBehTiming({ start: v }, 'beh-start')" />
      <StudioSlider data-testid="beh-duration" v-bind="gesture('beh-duration')"
        :label="behaviour.timing.loop ? 'Cycle' : 'Duration'"
        :hint="behaviour.timing.loop ? 'Length of one cycle — it repeats to the end of the timeline' : undefined"
        :model-value="+behaviour.timing.duration.toFixed(2)" :min="0.05" :max="timeMax" :step="0.05" :default="1"
        @update:model-value="(v) => setBehTiming({ duration: Math.max(0.05, v) }, 'beh-duration')" />
      <StudioSwitch v-if="!isTextBeh" label="Loop" :model-value="behaviour.timing.loop ?? false"
        @update:model-value="(v) => setBehTiming({ loop: v })" />
    </div>

    <div class="mt-2 flex items-center justify-between border-t border-white/10 pt-2">
      <StudioButton data-testid="beh-delete" title="Remove this behaviour (Delete)"
        @click="emit('behaviour-delete', behaviour.id)">Delete</StudioButton>
      <StudioButton v-if="!isTextBeh" data-testid="beh-open" title="Bake into editable control-point bands"
        @click="emit('behaviour-open', behaviour.id)">Open into keyframes</StudioButton>
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
      <StudioButton variant="subtle" @click="emit('clear')">Done</StudioButton>
    </div>

    <!-- Control-point selected: typed value editor + ease -->
    <template v-if="point">
      <div v-if="typeof point.value === 'number'" class="mb-2">
        <StudioSlider data-testid="inspector-number" v-bind="gesture('inspector-number')"
          label="Value" :model-value="+point.value.toFixed(3)"
          :min="pointRange.min" :max="pointRange.max" :step="0.01"
          @update:model-value="(v) => setValue(v, 'inspector-number')" />
      </div>
      <div v-else-if="typeof point.value === 'string'" class="mb-2">
        <StudioColorField data-testid="inspector-color" label="Value" :model-value="point.value"
          @update:model-value="(v) => setValue(v)" />
      </div>
      <div v-else class="mb-2">
        <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">Value</div>
        <GradientEditor :model-value="pointGradient" @update:model-value="onGradient" />
      </div>
      <template v-if="!isLastPoint">
        <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">Ease to next point</div>
        <MotionEasingCurve class="mb-2" :ease="point.ease"
          @start="emit('before-change')" @change="setEaseLive" @end="emit('commit')" />
      </template>
      <StudioButton class="mt-1" title="Remove this control point (Delete)" @click="deletePoint">Delete point</StudioButton>
    </template>

    <!-- Property band selected: timing + easing + add point -->
    <template v-else>
      <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">Timing</div>
      <div class="mb-2 space-y-2">
        <StudioSlider data-testid="inspector-start" v-bind="gesture('inspector-start')"
          label="Start" :model-value="+span.start.toFixed(2)" :min="0" :max="timeMax" :step="0.05" :default="0"
          @update:model-value="setStart" />
        <StudioSlider data-testid="inspector-duration" v-bind="gesture('inspector-duration')"
          label="Duration" :model-value="+(span.end - span.start).toFixed(2)" :min="0.05" :max="timeMax" :step="0.05" :default="1"
          @update:model-value="setDuration" />
      </div>
      <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">{{ track.keyframes.length > 2 ? 'Easing (all points)' : 'Easing' }}</div>
      <MotionEasingCurve class="mb-2" :ease="track.keyframes[0]?.ease ?? 'linear'"
        @start="emit('before-change')" @change="setAllEaseLive" @end="emit('commit')" />
      <StudioSwitch class="mb-2" data-testid="band-loop" label="Loop"
        hint="Repeat this band to the end of the timeline — the bar is one cycle"
        :model-value="!!track.loop" @update:model-value="(v) => apply({ ...track!, loop: v })" />
      <div class="flex items-center justify-between">
        <span class="text-white/40">{{ track.keyframes.length }} control points</span>
        <StudioButton data-testid="inspector-add-point" @click="addAtPlayhead">＋ point</StudioButton>
      </div>
      <div class="mt-2 flex items-center justify-between border-t border-white/10 pt-2">
        <StudioButton data-testid="band-delete" title="Remove this band and all its points (Delete)"
          @click="deleteBand">Delete band</StudioButton>
      </div>
    </template>
  </div>
</template>
