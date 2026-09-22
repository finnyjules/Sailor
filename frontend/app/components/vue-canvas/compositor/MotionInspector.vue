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
import { REVEAL_DEFAULTS, REVEAL_RANGES, REVEAL_STYLES, REVEAL_LOOKS, revealParams, revealCellDefault, PIXEL_CHARS, DITHER_PATTERNS, DEFAULT_CUSTOM_CHARS, SETTLE_EFFECTS, settleParams } from '~/lib/motionx/reveal'

export type BehaviourPatch = { params?: Record<string, unknown>; timing?: Partial<Timing>; kind?: string; replaceParams?: boolean }
import { trackSpan, behaviourLabel } from '~/lib/motionx/bands'
import { letterMoves, letterMoveOf, swapLetterMove } from '~/lib/motionx/gallery'
import { retimeTrack, addPoint, setPointValue, setPointEase, removePoint, setBandTrack, bandTrackAt } from '~/lib/motionx/bandEdit'
import { DEFAULT_TEXT_EASE, isTextBehaviour, pieceRanks, pieceTiming, textBehaviourHidesBefore, textBehaviourPhase, textBehaviourUsesEase, type Order } from '~/lib/motionx/text'
import { NO_RUN, openRun, closeRun, takeRecord, type UndoRun } from '~/lib/motionx/undoCoalesce'
import GradientEditor from '~/components/vue-canvas/compositor/GradientEditor.vue'
import MotionEasingCurve from '~/components/vue-canvas/compositor/MotionEasingCurve.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSegmentedRow from '~/components/vue-canvas/studio/StudioSegmentedRow.vue'
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
// The ONE reader of a dither bar's stored params — every enum computed below reads off this,
// instead of calling `revealParams` again itself, so an unknown or missing value falls back to
// the library's own default (Pixels / Dither) rather than a second, locally-guessed one.
const reveal = computed(() => revealParams(behaviour.value?.params))
const ditherStyle = computed(() => reveal.value.style)
const ditherChars = computed(() => String(reveal.value.chars))
// Assemble-only (Task 13): the block Look (Dither / Characters) and, for the Dither look, its
// Pattern — both enums, so both are read off the shared `reveal` computed like `ditherStyle`.
const ditherLook = computed(() => reveal.value.look)
const ditherPattern = computed(() => String(reveal.value.pattern))
/** Pixels halves the block until the shader stops refining, so a dial finer than the first
 *  halving has no ladder at all (see `pixelFinest`): 4‰ is the coarsest floor that always
 *  leaves something to halve. Assemble's block never halves, but a floor below 2‰ is a
 *  scatter smaller than the dither pattern it samples; the mask styles keep the library's
 *  own floor. */
const ditherCellMin = computed(() => (ditherStyle.value === 'pixels' ? 4 : ditherStyle.value === 'assemble' ? 2 : REVEAL_RANGES.cell[0]))
const ditherCellLabel = computed(() => (
  ditherStyle.value === 'pixels' || ditherStyle.value === 'assemble' ? 'Block size'
    : ditherStyle.value === 'dots' ? 'Dot spacing' : 'Cell size'
))
const ditherCellHint = computed(() => (
  ditherStyle.value === 'pixels'
    ? "How big the cells are when the transition starts, in thousandths of the frame's width. They halve until the layer is sharp."
    : ditherStyle.value === 'assemble'
    ? 'How big the cells are. They stay this size for the whole transition.'
    : "How chunky the pattern is, in thousandths of the frame's width"
))
const ditherDriftLabel = computed(() => (
  ditherStyle.value === 'pixels' || ditherStyle.value === 'assemble' ? 'Shimmer speed' : 'Drift speed'
))
const ditherDriftHint = computed(() => (
  ditherStyle.value === 'pixels'
    ? 'How fast the characters re-roll while the layer sharpens. 0 is still.'
    : ditherStyle.value === 'assemble'
    ? 'How fast the scattered order re-rolls. 0 is still.'
    : 'How fast the pattern slides while the layer resolves, in cells per second. 0 is a still dither.'
))
// Settle (Addendum 3, Part 4): the ONE reader of a settle bar's stored params, same idiom as
// `reveal` above — every settle-only computed reads off this rather than re-guessing a default.
const settle = computed(() => settleParams(behaviour.value?.params))
/** A discrete edit — an option, a switch, a shuffle. Always its own undo step. */
function setBehParams(patch: Record<string, unknown>) {
  undoRun = closeRun()
  if (behaviour.value) emit('behaviour-change', behaviour.value.id, { params: patch })
}
// Swap a Letters bar for another move in place: same bar, same timing, same Text settings and
// curve — only the move (and the params that belonged to it) changes. One undo step.
const LETTER_MOVES = letterMoves()
const LETTER_MOVE_IDS = LETTER_MOVES.map((m) => m.id)
const LETTER_MOVE_LABELS = LETTER_MOVES.map((m) => m.label)
const letterMoveId = computed(() => (behaviour.value ? letterMoveOf(behaviour.value)?.id : undefined) ?? '')
function swapMove(id: string) {
  const b = behaviour.value
  const move = LETTER_MOVES.find((m) => m.id === id)
  if (!b || !move || id === letterMoveId.value) return
  undoRun = closeRun()
  emit('behaviour-change', b.id, { ...swapLetterMove(b, move), replaceParams: true })
}
/** A row-slider edit: the first value of a gesture records, the rest ride along. */
function setBehNum(key: string, patch: Record<string, unknown>) {
  if (behaviour.value) emit('behaviour-change', behaviour.value.id, { params: patch }, recordFor(key))
}
// Custom characters (Task 15): there is no Studio text control, so the row below borrows the
// easing editor's own row idiom (`MotionEasingCurve.vue`'s `easing-text` field) instead of a
// StudioSlider/StudioSelect. Undo is ONE step per EDIT SESSION (focus → type → blur), the same
// "first value records, the rest ride along" shape `gesture`/`setBehNum` give a slider drag:
// `before-change` fires once, on the FIRST input after a focus; every value after that
// (that first one included) writes live with `record = false`.
let customCharsSession = false
function onCustomCharsFocus() { customCharsSession = false }
function onCustomCharsBlur() { customCharsSession = false }
function onCustomCharsInput(value: string) {
  if (!behaviour.value) return
  if (!customCharsSession) { customCharsSession = true; emit('before-change') }
  emit('behaviour-change', behaviour.value.id, { params: { customChars: value } }, false)
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
// `REVEAL_STYLES` is `readonly RevealStyle[]` (the library's own list, Pixels first, Assemble
// second); copied into a plain mutable string[] so it can feed a Studio control's `options` prop.
const DITHER_STYLES: string[] = [...REVEAL_STYLES]
const DITHER_STYLE_LABELS = ['Pixels', 'Assemble', 'Dissolve', 'Wipe', 'Dots']
// `PIXEL_CHARS` values as strings for the Characters select (a Studio option list is always
// strings); `revealParams` reads the stored number back with `Number(...)`.
const PIXEL_CHAR_OPTIONS = PIXEL_CHARS.map((c) => String(c.value))
const PIXEL_CHAR_LABELS = PIXEL_CHARS.map((c) => c.label)
// Assemble's Look segmented row and, for the Dither look, its Pattern select — same pairing
// idiom as DITHER_STYLES / PIXEL_CHAR_OPTIONS above.
const DITHER_LOOKS: string[] = [...REVEAL_LOOKS]
const DITHER_LOOK_LABELS = ['Dither', 'Characters']
const DITHER_PATTERN_OPTIONS = DITHER_PATTERNS.map((p) => String(p.value))
const DITHER_PATTERN_LABELS = DITHER_PATTERNS.map((p) => p.label)
// Settle's Effect select — the ten `SETTLE_EFFECTS` rows, same id/label pairing idiom.
const SETTLE_EFFECT_OPTIONS = SETTLE_EFFECTS.map((e) => e.id)
const SETTLE_EFFECT_LABELS = SETTLE_EFFECTS.map((e) => e.label)

// ── Copies bars (cloner motion, Task 8) ──────────────────────────────────────
// Four of the five Copies behaviours run either way round, so they show ONE Direction row —
// the same segmented row a Fade bar shows. `copies.spin` is the fifth and has none: a ring
// turns one way, and its compiler reads no `dir`. Spread words its two ways as the gallery
// tiles do (Spread out / Gather in) rather than as In / Out, and its 'out' is the GROWING
// one; every default below is the compiler's own, never a second guess at it.
const SPREAD_DIRS = ['out', 'in']
const SPREAD_DIR_LABELS = ['Spread out', 'Gather in']
const COPIES_DIR_KINDS = ['copies.build', 'copies.spread', 'copies.fan', 'copies.fade']
const isCopiesDirBeh = computed(() => COPIES_DIR_KINDS.includes(behaviour.value?.kind ?? ''))
const isCopiesSpread = computed(() => behaviour.value?.kind === 'copies.spread')
const copiesDirOptions = computed(() => (isCopiesSpread.value ? SPREAD_DIRS : IN_OUT))
const copiesDirLabels = computed(() => (isCopiesSpread.value ? SPREAD_DIR_LABELS : IN_OUT_LABELS))
const copiesDirDefault = computed(() => (isCopiesSpread.value ? 'out' : 'in'))

// ── Letter behaviours (Task 5) ───────────────────────────────────────────────
const isTextBeh = computed(() => behaviour.value != null && isTextBehaviour(behaviour.value))
const BY_OPTIONS = ['letters', 'words', 'lines']
const BY_LABELS = ['Letters', 'Words', 'Lines']
const ORDER_OPTIONS = ['ltr', 'rtl', 'center', 'edges', 'random']
const ORDER_LABELS = ['Left to right', 'Right to left', 'Centre out', 'Edges in', 'Random']
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
const CHARSET_LABELS = ['Letters from the text', 'Letters', 'Numbers', 'Symbols', 'Mixed']
// A Slot reel can also roll its own letter past; a Decode cannot (it would show no change).
const SLOT_FILLER_OPTIONS = ['same', ...CHARSET_OPTIONS]
const SLOT_FILLER_LABELS = ['Same letter', ...CHARSET_LABELS]

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
// Shuffle re-rolls the ONE seed behind everything random in a move, so it sits beside what it
// visibly changes: at the end of the move's own rows when the move itself is random (a Slot's
// fillers, a Scramble's spots), under Order when the random ORDER is the only random thing,
// and nowhere when nothing is (a Slot rolling its own letter in reading order).
const HASHED_KINDS = ['text.scramble', 'text.decode', 'text.slot', 'text.jitter']
const shuffleAt = computed<'move' | 'order' | null>(() => {
  const beh = behaviour.value
  if (!beh) return null
  const moveIsRandom = HASHED_KINDS.includes(beh.kind)
    && !(beh.kind === 'text.slot' && enumParam('filler', 'letters') === 'same')
  if (moveIsRandom) return 'move'
  return !isLoopBeh.value && enumParam('order', 'ltr') === 'random' ? 'order' : null
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
// Entrances only: does the text stay hidden until this bar starts? The default depends on the
// kind (a cascade reveals the text, a scramble does not) — read from the evaluator, never
// duplicated here — and the switch overrides it either way.
const isTextEntrance = computed(() =>
  !!behaviour.value && isTextBeh.value && textBehaviourPhase(behaviour.value.kind, behaviour.value.params ?? {}) === 'in')
const hidesBefore = computed(() =>
  !!behaviour.value && textBehaviourHidesBefore(behaviour.value.kind, behaviour.value.params ?? {}))
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
// How long ONE piece plays for (the bar minus the total stagger). A consequence of Stagger and
// Duration, so it lives in Stagger's own tooltip — not as a standing line in the panel.
const pieceLine = computed(() => {
  if (!pieceTimingInfo.value) return null
  const by = enumParam('by', 'letters')
  const prefix = by === 'lines' ? 'About each' : 'Each'
  return `${prefix} piece runs for ${pieceTimingInfo.value.pieceDur.toFixed(2)}s.`
})
const staggerHint = computed(() =>
  'Seconds between one piece starting and the next.' + (pieceLine.value ? ' ' + pieceLine.value : ''))
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
        <StudioSegmentedRow label="Direction"
          :model-value="enumParam('dir', 'in')" :options="IN_OUT" :option-labels="IN_OUT_LABELS"
          @update:model-value="(v) => setBehParams({ dir: v })" />
      </template>
      <template v-else-if="behaviour.kind === 'scale'">
        <StudioSegmentedRow label="Direction"
          data-testid="scale-dir" :model-value="enumParam('dir', 'in')" :options="['in', 'out']" :option-labels="['Grow in', 'Shrink out']"
          @update:model-value="(v) => setBehParams({ dir: v })" />
        <StudioSlider data-testid="scale-from" v-bind="gesture('scale-from')"
          label="Start size %" hint="100% is the layer's own size"
          :model-value="numParam('from', enumParam('dir', 'in') === 'out' ? 100 : 0)" :min="0" :max="400" :step="1"
          :default="enumParam('dir', 'in') === 'out' ? 100 : 0"
          @update:model-value="(v) => setBehNum('scale-from', { from: v })" />
        <StudioSlider data-testid="scale-to" v-bind="gesture('scale-to')"
          label="Finish size %" hint="100% is the layer's own size. The layer keeps this size after the bar ends."
          :model-value="numParam('to', enumParam('dir', 'in') === 'out' ? 0 : 100)" :min="0" :max="400" :step="1"
          :default="enumParam('dir', 'in') === 'out' ? 0 : 100"
          @update:model-value="(v) => setBehNum('scale-to', { to: v })" />
      </template>
      <template v-else-if="behaviour.kind === 'slide'">
        <StudioSegmentedRow label="Direction"
          :model-value="enumParam('dir', 'up')" :options="SLIDE_DIRS" :option-labels="SLIDE_DIR_LABELS"
          @update:model-value="(v) => setBehParams({ dir: v })" />
        <StudioSlider data-testid="slide-distance" v-bind="gesture('slide-distance')"
          label="Distance" hint="Fraction of the frame (0–1)"
          :model-value="numParam('distance', 0.15)" :min="0" :max="1" :step="0.01" :default="0.15"
          @update:model-value="(v) => setBehNum('slide-distance', { distance: v })" />
      </template>
      <template v-else-if="behaviour.kind === 'dither'">
        <StudioSelect data-testid="dither-style" label="Style"
          :model-value="ditherStyle" :options="DITHER_STYLES" :option-labels="DITHER_STYLE_LABELS"
          @update:model-value="(v) => setBehParams({ style: v })" />
        <StudioSegmentedRow v-if="ditherStyle === 'assemble'" data-testid="dither-look" label="Look"
          :model-value="ditherLook" :options="DITHER_LOOKS" :option-labels="DITHER_LOOK_LABELS"
          @update:model-value="(v) => setBehParams({ look: v })" />
        <StudioSelect v-if="ditherStyle === 'assemble' && ditherLook === 'dither'" data-testid="dither-pattern" label="Pattern"
          hint="The same patterns as the Dither effect in Shader Studio"
          :model-value="ditherPattern" :options="DITHER_PATTERN_OPTIONS" :option-labels="DITHER_PATTERN_LABELS"
          @update:model-value="(v) => setBehParams({ pattern: Number(v) })" />
        <StudioSlider v-if="ditherStyle === 'assemble' && ditherLook === 'dither'" data-testid="dither-levels" v-bind="gesture('dither-levels')"
          label="Colour levels" hint="How few colours each block can take. 2 is harsh, 8 is nearly smooth."
          :model-value="numParam('levels', REVEAL_DEFAULTS.levels)" :min="2" :max="8" :step="1" :default="REVEAL_DEFAULTS.levels"
          @update:model-value="(v) => setBehNum('dither-levels', { levels: v })" />
        <StudioSelect v-if="ditherStyle === 'pixels' || (ditherStyle === 'assemble' && ditherLook === 'characters')" data-testid="dither-chars" label="Characters"
          hint="The same character sets as the ASCII effect in Shader Studio"
          :model-value="ditherChars" :options="PIXEL_CHAR_OPTIONS" :option-labels="PIXEL_CHAR_LABELS"
          @update:model-value="(v) => setBehParams({ chars: Number(v) })" />
        <!-- Custom characters (Task 15): the user types the picture's own glyphs. No Studio text
             control exists, so this row borrows the easing editor's coordinates-field idiom —
             same height/radius/background, label on the left in the slider-label style. -->
        <div v-if="(ditherStyle === 'pixels' || (ditherStyle === 'assemble' && ditherLook === 'characters')) && ditherChars === '14'"
          class="flex h-7 items-center justify-between gap-3 rounded-[6px] bg-white/[0.05] px-2.5">
          <span class="shrink-0 text-[11px] text-white/72" title="Type the characters to build the picture from. They are sorted from light to dark for you.">Your characters</span>
          <input type="text" data-testid="dither-custom-chars" data-owns-keys spellcheck="false" maxlength="64"
            :placeholder="DEFAULT_CUSTOM_CHARS"
            class="min-w-0 flex-1 bg-transparent text-right text-[11px] text-white/90 outline-none placeholder:text-white/30"
            :value="behParam('customChars') ?? ''"
            @focus="onCustomCharsFocus" @blur="onCustomCharsBlur"
            @input="onCustomCharsInput(($event.target as HTMLInputElement).value)">
        </div>
        <StudioSegmentedRow data-testid="dither-dir" label="Direction"
          :model-value="enumParam('dir', 'in')" :options="IN_OUT" :option-labels="IN_OUT_LABELS"
          @update:model-value="(v) => setBehParams({ dir: v })" />
        <StudioSlider data-testid="dither-cell" v-bind="gesture('dither-cell')"
          :label="ditherCellLabel" :hint="ditherCellHint"
          :model-value="numParam('cell', revealCellDefault(ditherStyle))" :min="ditherCellMin" :max="REVEAL_RANGES.cell[1]" :step="1" :default="revealCellDefault(ditherStyle)"
          @update:model-value="(v) => setBehNum('dither-cell', { cell: v })" />
        <StudioSlider v-if="ditherStyle === 'assemble'" data-testid="dither-band" v-bind="gesture('dither-band')"
          label="Band width" hint="How much of the layer is in block form at once. At 100 the whole layer is blocks before it turns sharp."
          :model-value="numParam('band', REVEAL_DEFAULTS.band)" :min="0" :max="100" :step="1" :default="REVEAL_DEFAULTS.band"
          @update:model-value="(v) => setBehNum('dither-band', { band: v })" />
        <StudioSlider v-if="ditherStyle === 'assemble'" data-testid="dither-scatter" v-bind="gesture('dither-scatter')"
          label="Scatter" hint="How far ahead of the edge cells start appearing. 0 is a hard line."
          :model-value="numParam('scatter', REVEAL_DEFAULTS.scatter)" :min="0" :max="100" :step="1" :default="REVEAL_DEFAULTS.scatter"
          @update:model-value="(v) => setBehNum('dither-scatter', { scatter: v })" />
        <StudioSlider data-testid="dither-drift" v-bind="gesture('dither-drift')"
          :label="ditherDriftLabel" :hint="ditherDriftHint"
          :model-value="numParam('drift', REVEAL_DEFAULTS.drift)" :min="REVEAL_RANGES.drift[0]" :max="REVEAL_RANGES.drift[1]" :step="0.5" :default="REVEAL_DEFAULTS.drift"
          @update:model-value="(v) => setBehNum('dither-drift', { drift: v })" />
        <StudioSlider v-if="ditherStyle !== 'pixels'" data-testid="dither-angle" v-bind="gesture('dither-angle')"
          label="Angle" hint="The way the pattern drifts and, for Wipe and Assemble, the way the edge travels. 0 is towards the right, 90 is downwards."
          :model-value="numParam('angle', REVEAL_DEFAULTS.angle)" :min="REVEAL_RANGES.angle[0]" :max="REVEAL_RANGES.angle[1]" :step="1" :default="REVEAL_DEFAULTS.angle"
          @update:model-value="(v) => setBehNum('dither-angle', { angle: v })" />
        <StudioSlider v-if="ditherStyle === 'wipe'" data-testid="dither-softness" v-bind="gesture('dither-softness')"
          label="Edge softness" hint="How wide the dithered band on the travelling edge is. 0 is a hard line."
          :model-value="numParam('softness', REVEAL_DEFAULTS.softness)" :min="REVEAL_RANGES.softness[0]" :max="REVEAL_RANGES.softness[1]" :step="0.01" :default="REVEAL_DEFAULTS.softness"
          @update:model-value="(v) => setBehNum('dither-softness', { softness: v })" />
      </template>
      <template v-else-if="behaviour.kind === 'settle'">
        <StudioSelect data-testid="settle-effect" label="Effect"
          hint="Swap this bar for another shader effect. Timing, easing, direction, strength and fade are kept."
          :model-value="settle.effect.id" :options="SETTLE_EFFECT_OPTIONS" :option-labels="SETTLE_EFFECT_LABELS"
          @update:model-value="(v) => setBehParams({ effect: v })" />
        <StudioSegmentedRow data-testid="settle-dir" label="Direction"
          :model-value="enumParam('dir', 'in')" :options="IN_OUT" :option-labels="IN_OUT_LABELS"
          @update:model-value="(v) => setBehParams({ dir: v })" />
        <StudioSlider data-testid="settle-strength" v-bind="gesture('settle-strength')"
          label="Starting strength" hint="How broken the layer is when the transition starts. It settles to nothing by the end."
          :model-value="numParam('strength', 70)" :min="0" :max="100" :step="1" :default="70"
          @update:model-value="(v) => setBehNum('settle-strength', { strength: v })" />
        <StudioSwitch data-testid="settle-fade" label="Fade while it settles"
          :model-value="settle.fade" @update:model-value="(v) => setBehParams({ fade: v })" />
      </template>
      <template v-else-if="isCopiesDirBeh">
        <StudioSegmentedRow data-testid="copies-dir" label="Direction"
          :model-value="enumParam('dir', copiesDirDefault)" :options="copiesDirOptions" :option-labels="copiesDirLabels"
          @update:model-value="(v) => setBehParams({ dir: v })" />
      </template>
      <template v-else-if="behaviour.kind === 'gradientMorph'">
        <StudioSegmentedRow label="Mode"
          :model-value="enumParam('mode', 'crossfade')" :options="MORPH_MODES" :option-labels="MORPH_MODE_LABELS"
          @update:model-value="(v) => setBehParams({ mode: v })" />
        <StudioSegmentedRow label="Colour"
          :model-value="enumParam('space', 'oklab')" :options="MORPH_SPACES" :option-labels="MORPH_SPACE_LABELS"
          @update:model-value="(v) => setBehParams({ space: v })" />
      </template>
      <template v-else-if="isTextBeh">
        <StudioSelect data-testid="letters-move" label="Behaviour"
          hint="Swap this bar for another letter move. Timing, stagger and easing are kept."
          :model-value="letterMoveId" :options="LETTER_MOVE_IDS" :option-labels="LETTER_MOVE_LABELS"
          @update:model-value="swapMove" />
        <div class="mi-heading">Text</div>
        <StudioSegmentedRow data-testid="letters-by" label="Animate by"
          :model-value="enumParam('by', 'letters')" :options="BY_OPTIONS" :option-labels="BY_LABELS"
          @update:model-value="(v) => setBehParams({ by: v })" />
        <StudioSlider v-if="!isLoopBeh" data-testid="letters-stagger" v-bind="gesture('letters-stagger')"
          label="Stagger" :hint="staggerHint"
          :model-value="numParam('stagger', 0.04)" :min="0" :max="0.5" :step="0.01" :default="0.04"
          @update:model-value="(v) => setBehNum('letters-stagger', { stagger: v })" />
        <!-- Only when it bites: the pieces could not all start inside the bar at this stagger. -->
        <div v-if="staggerShortened && !isLoopBeh" data-testid="letters-stagger-shortened"
          class="px-2.5 text-[10px] leading-snug text-amber-300/80">
          Playing at {{ pieceTimingInfo!.staggerUsed.toFixed(2) }}s so every piece fits in the bar. Lengthen the bar to use the full stagger.
        </div>
        <StudioSelect data-testid="letters-order" label="Order"
          :model-value="enumParam('order', 'ltr')" :options="ORDER_OPTIONS" :option-labels="ORDER_LABELS"
          @update:model-value="(v) => setBehParams({ order: v })" />
        <div v-if="shuffleAt === 'order'" data-testid="letters-shuffle-row"
          class="flex h-7 select-none items-center justify-between gap-2 rounded-[6px] bg-white/[0.05] pl-2.5 pr-[3px]">
          <span class="min-w-0 truncate text-[11px] text-white/72">Random order</span>
          <StudioButton data-testid="letters-shuffle" title="Pick a new random order"
            class="h-[22px] !rounded-[4px] !px-2.5 !py-0 !text-[11px] after:!inset-y-0" @click="shuffleSeed">Shuffle</StudioButton>
        </div>
        <StudioSwitch v-if="isTextEntrance" data-testid="letters-hide-before" label="Hide text before it starts"
          hint="On: the text only appears through this move. Off: the text is already there, and this move plays over it."
          :model-value="hidesBefore" @update:model-value="(v) => setBehParams({ hideBefore: v })" />

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
          <StudioSegmentedRow data-testid="cascade-dir" label="Direction"
            :model-value="enumParam('dir', 'in')" :options="IN_OUT" :option-labels="IN_OUT_LABELS"
            @update:model-value="(v) => setBehParams({ dir: v })" />
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
          <StudioSegmentedRow data-testid="typewriter-dir" label="Direction"
            :model-value="enumParam('dir', 'type')" :options="TYPE_DIR_OPTIONS" :option-labels="TYPE_DIR_LABELS"
            @update:model-value="(v) => setBehParams({ dir: v })" />
          <StudioSelect data-testid="typewriter-cursor" label="Cursor"
            :model-value="enumParam('cursor', 'bar')" :options="CURSOR_OPTIONS" :option-labels="CURSOR_LABELS"
            @update:model-value="(v) => setBehParams({ cursor: v })" />
          <StudioSlider data-testid="typewriter-blink" v-bind="gesture('typewriter-blink')"
            label="Blink (per second)"
            :model-value="numParam('blink', 0)" :min="0" :max="8" :step="0.5" :default="0"
            @update:model-value="(v) => setBehNum('typewriter-blink', { blink: v })" />
        </template>
        <template v-else-if="behaviour.kind === 'text.maskSlide'">
          <StudioSegmentedRow data-testid="mask-dir" label="Direction"
            :model-value="enumParam('dir', 'reveal')" :options="MASK_DIR_OPTIONS" :option-labels="MASK_DIR_LABELS"
            @update:model-value="(v) => setBehParams({ dir: v })" />
          <StudioSelect data-testid="mask-from" label="Travel"
            :model-value="enumParam('from', 'up')" :options="MASK_FROM_OPTIONS" :option-labels="MASK_FROM_LABELS"
            @update:model-value="(v) => setBehParams({ from: v })" />
        </template>
        <template v-else-if="behaviour.kind === 'text.scramble'">
          <StudioSegmentedRow data-testid="scramble-mode" label="Mode"
            :model-value="enumParam('mode', 'settle')" :options="SCRAMBLE_MODE_OPTIONS" :option-labels="SCRAMBLE_MODE_LABELS"
            @update:model-value="(v) => setBehParams({ mode: v })" />
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
          <StudioSegmentedRow data-testid="scramble-move" label="Move"
            :model-value="enumParam('move', 'snap')" :options="SCRAMBLE_MOVE_OPTIONS" :option-labels="SCRAMBLE_MOVE_LABELS"
            @update:model-value="(v) => setBehParams({ move: v })" />
          <StudioSlider data-testid="scramble-spin" v-bind="gesture('scramble-spin')"
            label="Spin (degrees)"
            :model-value="numParam('spin', 0)" :min="0" :max="180" :step="1" :default="0"
            @update:model-value="(v) => setBehNum('scramble-spin', { spin: v })" />
        </template>
        <template v-else-if="behaviour.kind === 'text.decode'">
          <StudioSegmentedRow data-testid="decode-dir" label="Direction"
            :model-value="enumParam('dir', 'resolve')" :options="DECODE_DIR_OPTIONS" :option-labels="DECODE_DIR_LABELS"
            @update:model-value="(v) => setBehParams({ dir: v })" />
          <StudioSelect data-testid="decode-charset" label="Characters"
            :model-value="enumParam('charset', 'text')" :options="CHARSET_OPTIONS" :option-labels="CHARSET_LABELS"
            @update:model-value="(v) => setBehParams({ charset: v })" />
          <StudioSlider data-testid="decode-rate" v-bind="gesture('decode-rate')"
            label="Flicker rate (per second)"
            :model-value="numParam('rate', 14)" :min="1" :max="40" :step="1" :default="14"
            @update:model-value="(v) => setBehNum('decode-rate', { rate: v })" />
        </template>
        <template v-else-if="behaviour.kind === 'text.slot'">
          <StudioSegmentedRow data-testid="slot-dir" label="Direction"
            :model-value="enumParam('dir', 'in')" :options="IN_OUT" :option-labels="IN_OUT_LABELS"
            @update:model-value="(v) => setBehParams({ dir: v })" />
          <StudioSegmentedRow data-testid="slot-roll" label="Roll"
            :model-value="enumParam('roll', 'up')" :options="SLOT_ROLL_OPTIONS" :option-labels="SLOT_ROLL_LABELS"
            @update:model-value="(v) => setBehParams({ roll: v })" />
          <StudioSlider data-testid="slot-steps" v-bind="gesture('slot-steps')"
            label="Steps" hint="How many characters roll past before it lands"
            :model-value="numParam('steps', 8)" :min="1" :max="40" :step="1" :default="8"
            @update:model-value="(v) => setBehNum('slot-steps', { steps: v })" />
          <StudioSelect data-testid="slot-filler" label="Filler"
            :model-value="enumParam('filler', 'letters')" :options="SLOT_FILLER_OPTIONS" :option-labels="SLOT_FILLER_LABELS"
            @update:model-value="(v) => setBehParams({ filler: v })" />
        </template>
        <div v-if="shuffleAt === 'move'" data-testid="letters-shuffle-row"
          class="flex h-7 select-none items-center justify-between gap-2 rounded-[6px] bg-white/[0.05] pl-2.5 pr-[3px]">
          <span class="min-w-0 truncate text-[11px] text-white/72">Variation</span>
          <StudioButton data-testid="letters-shuffle" title="Re-roll everything random in this move"
            class="h-[22px] !rounded-[4px] !px-2.5 !py-0 !text-[11px] after:!inset-y-0" @click="shuffleSeed">Shuffle</StudioButton>
        </div>
      </template>
    </div>

    <template v-if="showEasing">
      <div class="mi-heading">Easing</div>
      <MotionEasingCurve class="mb-2" :ease="behEase"
        @start="emit('before-change')" @change="setBehEaseLive" @end="emit('commit')" />
    </template>

    <div class="mi-heading">Timing</div>
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
      <StudioButton v-if="!isTextBeh && behaviour.kind !== 'dither' && behaviour.kind !== 'settle'" data-testid="beh-open" title="Bake into editable control-point bands"
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
        <div class="mi-heading">Value</div>
        <GradientEditor :model-value="pointGradient" @update:model-value="onGradient" />
      </div>
      <template v-if="!isLastPoint">
        <div class="mi-heading">Ease to next point</div>
        <MotionEasingCurve class="mb-2" :ease="point.ease"
          @start="emit('before-change')" @change="setEaseLive" @end="emit('commit')" />
      </template>
      <StudioButton class="mt-1" title="Remove this control point (Delete)" @click="deletePoint">Delete point</StudioButton>
    </template>

    <!-- Property band selected: timing + easing + add point -->
    <template v-else>
      <div class="mi-heading">Timing</div>
      <div class="mb-2 space-y-2">
        <StudioSlider data-testid="inspector-start" v-bind="gesture('inspector-start')"
          label="Start" :model-value="+span.start.toFixed(2)" :min="0" :max="timeMax" :step="0.05" :default="0"
          @update:model-value="setStart" />
        <StudioSlider data-testid="inspector-duration" v-bind="gesture('inspector-duration')"
          label="Duration" :model-value="+(span.end - span.start).toFixed(2)" :min="0.05" :max="timeMax" :step="0.05" :default="1"
          @update:model-value="setDuration" />
      </div>
      <div class="mi-heading">{{ track.keyframes.length > 2 ? 'Easing (all points)' : 'Easing' }}</div>
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

<style scoped>
/* A section title (Text, Easing, Timing…). The rows inside a section sit 8px apart, so a
   title needs clearly MORE than that above it or the sections run together; the first title
   in a card has the card's own header above it and needs none. Two classes, so it beats the
   stack's own `space-y` margin wherever a title sits inside one. */
.mi-heading.mi-heading {
  margin: 20px 0 8px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.025em;
  color: rgb(255 255 255 / 0.35);
}
.mi-heading.mi-heading:first-child { margin-top: 0; }
</style>
