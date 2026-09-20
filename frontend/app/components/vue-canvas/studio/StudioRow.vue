<script setup lang="ts">
/**
 * One studio control, as one 28px row. The row IS the control: the fill behind it
 * shows the value, dragging anywhere on it scrubs, clicking the number types an
 * exact value, and double-clicking resets to the declared default.
 *
 * Kind-agnostic on purpose — the value side comes from rows/registry.ts, so this
 * file never grows a per-kind branch. Complex kinds (curve, path, gradientStops,
 * fillList) render this row as a header and expand a body beneath it via the
 * #body slot.
 */
import { computed, nextTick, ref } from 'vue'
import type { ControlSpec } from '~/lib/spacetype/effect'
import { fillFraction, fillOrigin, formatValue, nudgeValue, parseTyped, resetValue } from '~/lib/studio/row'
import { scrubValue } from '~/lib/studio/scrub'
import { controlKindToVariableType } from '~/lib/collection/studioBindables'
import { resolveRowRenderer, NUMERIC_KINDS } from './rows/registry'
import VariableGlyph from './VariableGlyph.vue'
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipPortal, TooltipContent } from 'reka-ui'

// `bindable` is written as an OPT-OUT everywhere it is read (`bindable !== false`), but
// Vue casts an absent Boolean prop to `false` unless it has a default — so without this
// the variable glyph rendered on NO row at all, and the opt-out was unreachable. Found
// while checking the accessibility tree for the glyph the slider role was accused of
// hiding: it was not in the tree because it was not in the DOM.
const props = withDefaults(defineProps<{
  spec: ControlSpec
  modelValue: string | number | boolean
  bound?: string | null
  bindable?: boolean
}>(), { bound: null, bindable: true })
const emit = defineEmits<{
  (e: 'update:modelValue', v: string | number | boolean): void
  (e: 'promote'): void
  (e: 'menu', event: MouseEvent): void
  // Clicking a bound row's column name jumps to the wired Collection, replacing the
  // "Edit in table" button the old two-line bound row carried.
  (e: 'goToCollection'): void
}>()

const numeric = computed(() => NUMERIC_KINDS.has(props.spec.kind))
const renderer = computed(() => resolveRowRenderer(props.spec.kind))
const min = computed(() => Number((props.spec as { min?: number }).min ?? 0))
const max = computed(() => Number((props.spec as { max?: number }).max ?? 1))
const step = computed(() => Number((props.spec as { step?: number }).step ?? 1))
const num = computed(() => Number(props.modelValue))
/**
 * SOFT RANGE, opt-in per control. Undefined — every row in the app but 3D Studio's nine
 * Transform rows — means the declared range gates entry as it always has.
 *
 * It reaches every gesture that moves the value RELATIVE to where it already is: the text
 * field (`onCommit`), the arrow keys (`nudgeValue`) and the drag (`scrubValue`, which is
 * `startValue + travel` — so without the mode a 3px slip on a row reading 35 snapped it
 * back to 20). Click-to-position is the one gesture that stays bounded in both modes: it
 * is ABSOLUTE — "put the value at this place on the track" — and the track is the declared
 * range. `fillFraction` likewise keeps clamping, so an out-of-range value shows its true
 * number with the handle pinned at the end.
 */
const entryMode = computed(() => (props.spec as { entry?: 'unclamped' }).entry)

// The painted band runs between the origin and the value, so a bipolar slider grows
// out of the middle in whichever direction the value went.
const band = computed(() => {
  if (!numeric.value) return null
  const o = fillOrigin(min.value, max.value)
  const f = fillFraction(num.value, min.value, max.value)
  return { left: `${Math.min(o, f) * 100}%`, width: `${Math.abs(f - o) * 100}%` }
})

const editing = ref(false)
/**
 * A pointer drag is in flight. Drives the handle turning white, and keeps the handle and
 * ticks visible once the pointer has left the row — a drag with pointer capture routinely
 * travels past the row's edges, and `group-hover` alone would blink them off mid-gesture.
 */
const dragging = ref(false)

/** Where the handle sits, 0..100. Same fraction the band uses, so they cannot disagree. */
const handlePct = computed(() => fillFraction(num.value, min.value, max.value) * 100)

/**
 * Ticks as one repeating gradient rather than N elements: a row is 260px of a canvas that
 * can hold hundreds of nodes, and eight spans per row is eight spans too many. Eight
 * intervals reads as a scale without turning into a ruler.
 *
 * Deliberately quiet — 12% white, and SHORTER than the handle (8px against 14px in a 28px
 * row). The ticks are a ruler you read past; the handle is the thing you are moving, so it
 * has to win on both height and brightness or the row reads as a row of ticks.
 */
const TICK_EVERY = 12.5
const tickStyle = {
  backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.12) 0 1px, transparent 1px ${TICK_EVERY}%)`,
}

/**
 * The element that IS the slider, for both focus and ARIA. It is a leaf on purpose:
 * `slider` is a children-presentational role, so hanging it on the row container —
 * which holds the variable glyph's button, the bound column's button and, while
 * typing, an `<input>` — is the `nested-interactive` pattern, and its practical
 * effect is that assistive tech drops those controls from the tree entirely. The
 * track is a sibling of them instead, so the row exposes a slider AND its buttons.
 *
 * It is `pointer-events-none` so it never intercepts the row's own drag, which means
 * the browser's default mousedown-focus can never land on it — every focus below is
 * therefore explicit.
 */
const track = ref<HTMLElement | null>(null)

/** Give the keyboard somewhere to be after a gesture that had no focus of its own. */
function focusTrack() {
  track.value?.focus()
}

function onPointerDown(e: PointerEvent) {
  // Primary button only. A right-click fires `pointerdown` too, and without this the
  // gesture whose entire purpose is opening the bind menu would also capture, run
  // `up()` with no movement, and click-to-position a brand new value into the
  // parameter. Middle-click/back/forward are left alone for the same reason.
  if (e.button !== 0) return
  if (!numeric.value || editing.value) return
  const el = e.currentTarget as HTMLElement
  // Clicking a native range focuses it, and the row must behave the same or a
  // click-then-arrow does nothing. Focusing HERE does not survive: the compatibility
  // `mousedown` runs afterwards and its default action moves focus to the nearest
  // focusable ancestor — which, now that the container is not focusable, is `<body>`
  // (measured: activeElement came back null). So claim focus on the way back up,
  // still long before any keystroke. Registered before the `bound` return because a
  // read-only slider is still a tab stop worth landing on.
  //
  // ...but NOT when the press landed on one of the row's own controls. The variable
  // glyph and the bound-column button are real buttons the user just focused by
  // clicking, and stealing that focus back on pointerup is exactly the bug this
  // handler exists to avoid (observed: clicking the glyph left focus on the track).
  const hit = e.target as Element | null
  if (!hit?.closest?.('button, input, select, textarea, a[href]')) {
    el.addEventListener('pointerup', focusTrack, { once: true })
  }
  // Did the press land on the value readout? If so, a click there opens typed entry and a
  // drag there scrubs — the readout is no longer a dead zone, which is what stopped the
  // handle being draggable whenever it sat underneath the number.
  const onValue = !!hit?.closest?.('[data-row-value]')
  if (props.bound) return
  el.setPointerCapture(e.pointerId)
  // Per-gesture, not per-component: a second pointer going down mid-drag used to
  // reset a shared flag, so releasing the FIRST pointer read `dragged === false`
  // and fired a spurious click-to-position jump. The template never reads it, so
  // it does not need to be reactive either.
  let dragged = false
  dragging.value = true
  const startX = e.clientX
  const startValue = num.value
  function move(ev: PointerEvent) {
    if (ev.pointerId !== e.pointerId) return
    if (Math.abs(ev.clientX - startX) > 2) dragged = true
    if (!dragged) return
    // Shift is COARSE here, exactly as it is on the arrow keys: it widens the grid
    // rather than slowing the travel. How far it widens depends on the range — see
    // `coarseStepMultiplier`, which gives ×10, ×5, ×2, or (on a range too short to
    // absorb a jump) nothing at all. It used to mean the opposite (0.15× travel), so
    // the same key made the drag finer and the keyboard bigger.
    emit('update:modelValue', scrubValue({
      startValue, deltaPx: ev.clientX - startX,
      min: min.value, max: max.value, step: step.value, coarse: ev.shiftKey,
      entry: entryMode.value,
    }))
  }
  // Detaching is deliberately separate from finishing: `pointercancel` (touch, pen,
  // or the browser taking the gesture over for a scroll) never delivers `pointerup`,
  // and without this the `pointermove` listener stayed attached to the row with a
  // stale startX — after which merely HOVERING the row cleared the 2px test and
  // scrubbed continuously.
  function teardown() {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', onCancel)
    // Last, so a throw here can never leave the listeners attached.
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    dragging.value = false
  }
  function onCancel(ev: PointerEvent) {
    if (ev.pointerId !== e.pointerId) return
    teardown()
  }
  function up(ev: PointerEvent) {
    if (ev.pointerId !== e.pointerId) return
    teardown()
    // A press that moved past the 2px threshold was a drag; it has already scrubbed.
    if (dragged) return
    // A press with no movement is a click. On the value readout it opens typed entry (the
    // job onValuePointerDown used to do on pointerdown, moved here so the same gesture can
    // instead become a drag); anywhere else on the track it jumps to where they clicked.
    if (onValue) {
      editing.value = true
      return
    }
    const r = el.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width))
    const raw = min.value + f * (max.value - min.value)
    emit('update:modelValue', parseTyped(String(raw), min.value, max.value, step.value) ?? num.value)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', onCancel)
}

/**
 * The keyboard path. What this replaces was a native `<input type="range">` —
 * focusable, arrow-keyable, self-describing — and this row becomes every control in
 * every studio, so the regression would have been permanent. Arrows move one step,
 * Shift-arrow moves `coarseStepMultiplier` steps — up to ten (a native range's PageUp
 * jump, on a key people actually press), less on a range too short to absorb ten, and
 * nothing extra on one too short to absorb even two. Home/End pin the ends — except on a
 * soft-range row, where there are no ends to pin. Bound rows are inert here exactly as
 * they are under the pointer, and an open text field keeps its own arrows for caret
 * movement.
 */
function onKeydown(e: KeyboardEvent) {
  if (!numeric.value || props.bound || editing.value) return
  // The arithmetic lives in ~/lib/studio/row so it has a test path; both arrow branches
  // end in parseTyped, same as typed entry — carrying the SAME `entry` mode — so a keyed
  // value and a typed one can never land on different grids or different bounds.
  const args = {
    value: num.value, min: min.value, max: max.value, step: step.value,
    coarse: e.shiftKey, entry: entryMode.value,
  }
  let next: number
  switch (e.key) {
    case 'ArrowLeft': case 'ArrowDown': next = nudgeValue({ ...args, direction: -1 }); break
    case 'ArrowRight': case 'ArrowUp': next = nudgeValue({ ...args, direction: 1 }); break
    case 'Home': case 'End': {
      // On a soft range the bounds describe the parameter, they do not bound it, so
      // "jump to the end" names nothing — and on a value that legitimately sits outside
      // them it would be a large destructive write one keystroke away from the arrows.
      // Swallowed rather than ignored, so the key still cannot scroll the panel.
      if (entryMode.value === 'unclamped') { e.preventDefault(); return }
      const edge = e.key === 'Home' ? min.value : max.value
      next = parseTyped(String(edge), min.value, max.value, step.value) ?? num.value
      break
    }
    default: return
  }
  // Handled either way — an arrow at the maximum must still not scroll the panel.
  e.preventDefault()
  // ...but it must not WRITE either. At an end the nudge returns the current value,
  // and key repeat would otherwise pour identical no-op writes into the document and
  // its undo stack.
  if (next === num.value) return
  emit('update:modelValue', next)
}

function onReset() {
  if (props.bound) return
  if (!numeric.value) return
  emit('update:modelValue', resetValue({
    default: Number((props.spec as { default?: number }).default),
    min: min.value, max: max.value,
  }))
}

/**
 * Both endings of typed entry unmount the input, and focus then falls to `<body>` —
 * arrow keys go dead until the user tabs all the way back, where the native range
 * this replaced simply stayed focused. So hand focus to the track.
 *
 * Only when the focus was still OURS at the moment the ending fired, though: blur
 * commits (clicking away, which is a legitimate ending) run with focus already gone,
 * and stealing it back would yank the user off whatever they just clicked.
 */
function restoreFocus() {
  const active = document.activeElement
  const ours = !!active && !!track.value?.parentElement?.contains(active)
  if (!ours) return
  // After the unmount, or the input is still there to be blurred by the focus call.
  nextTick(focusTrack)
}

function onCommit(raw: string) {
  restoreFocus()
  editing.value = false
  const v = parseTyped(raw, min.value, max.value, step.value, { entry: entryMode.value })
  if (v !== null) emit('update:modelValue', v)
}

function onCancel() {
  restoreFocus()
  editing.value = false
}

/**
 * Clicking the value opens typed entry on numeric kinds. The wrapper span always
 * stops the event so the row's own drag never starts from the number — otherwise a
 * click meant to type would scrub by a pixel or two first.
 *
 * `preventDefault`, though, is scoped to the numeric case, and the scoping is the
 * whole point of doing this in a handler rather than with a `.prevent` modifier.
 * Cancelling `pointerdown` is what keeps the typed-entry field OPEN — otherwise the
 * compatibility `mousedown` runs its default action, moves focus to `<body>`, and
 * the field blur-commits shut in the same gesture it opened (Task 3's finding 1).
 * But that same cancellation also suppresses the default action that opens a native
 * `<select>` menu and the one that focuses a button, so applying it to every kind
 * would leave RowSelect's transparent select and RowColor's swatch dead on click.
 */
function onValuePointerDown(e: PointerEvent) {
  // Non-numeric rows (select, color) keep the press to themselves: the row is not a slider,
  // and their renderers need the native pointerdown to open a <select> menu or focus a
  // swatch, so the row's drag machinery must never start here.
  if (!numeric.value) {
    e.stopPropagation()
    return
  }
  // Numeric rows deliberately let the press BUBBLE to the row's `onPointerDown`. That is the
  // fix for "the handle is under the readout and won't drag": swallowing the press here (with
  // stopPropagation + immediate typed entry) made the ~64px number a dead zone for scrubbing.
  // A click with no movement past the row's 2px threshold still opens typed entry — resolved
  // in `up()` via the `data-row-value` marker — so the drag and the type never fight, and the
  // right-button / blur-commit hazards the old guard fended off cannot arise because the field
  // now opens on release rather than on the compatibility-mousedown-bearing press.
}
</script>

<template>
  <div>
    <!-- Borderless on purpose: the fill IS the control, and 40+ hairlines in one inspector
         read as a stack of boxes. A hairline was added on 2026-08-05 when rows looked
         transparent on a node, then removed once the real cause was found — recessive
         nodes were rendering at `opacity-70`, which is now gone (see ComfyNode.vue). Fixing
         the cause beat compensating for it in every studio. -->
    <!-- 6px. Every input and button in the app is 6px — the rule is chosen directly, and
         the card follows it rather than the other way round: the shell is 14 so that
         14 - 8 inset = 6 keeps the corners concentric, which is what stops the bottom of
         a node pinching against its run bar. 4px was tried first and read too sharp. -->
    <div
      class="group relative flex h-7 select-none items-center justify-between overflow-hidden rounded-[6px] bg-white/[0.05] px-2.5"
      :class="numeric && !bound && !editing ? 'cursor-ew-resize' : ''"
      @pointerdown="onPointerDown"
      @dblclick="onReset"
      @contextmenu.prevent="emit('menu', $event)"
    >
      <div
        v-if="band"
        class="pointer-events-none absolute inset-y-0"
        :style="{ left: band.left, width: band.width, background: bound ? 'rgba(244,114,182,0.32)' : 'rgba(255,255,255,0.22)' }"
      ></div>

      <!-- Ticks and handle: the row's mechanics, shown only when you are about to use it.
           At rest the row is a label and a number; on hover it admits to being a slider.
           Both stay up while `dragging`, because a captured drag routinely travels beyond
           the row's edges and `group-hover` alone would blink them off mid-gesture.
           Unbound only — a bound row is driven by its column, so offering the machinery
           of a drag would be a lie. -->
      <template v-if="numeric && !bound">
        <div
          class="pointer-events-none absolute inset-y-[10px] left-0 right-0 opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100"
          :class="dragging ? 'opacity-100' : ''"
          :style="tickStyle"
        ></div>
        <div
          class="pointer-events-none absolute top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-full opacity-0 transition-[opacity,background-color] [transition-duration:200ms,120ms] ease-out group-hover:opacity-100"
          :class="dragging ? 'bg-white opacity-100' : 'bg-white/60'"
          :style="{ left: `calc(${handlePct}% - 1px)` }"
        ></div>
      </template>

      <!-- The track: a childless element carrying the slider role, the tab stop and the
           keyboard, so the row's buttons stay siblings rather than descendants of a
           children-presentational role. Covers the whole row, so the focus ring is the
           row's outline and a screen reader's slider is the thing you actually drag. -->
      <div
        v-if="numeric"
        ref="track"
        tabindex="0"
        role="slider"
        class="pointer-events-none absolute inset-0 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/40"
        :aria-label="spec.label"
        :aria-valuemin="min"
        :aria-valuemax="max"
        :aria-valuenow="num"
        :aria-valuetext="bound ? bound : formatValue(num, step)"
        :aria-readonly="bound ? 'true' : undefined"
        @keydown="onKeydown"
      ></div>

      <span class="relative flex min-w-0 items-center gap-1.5">
        <TooltipProvider v-if="spec.hint" :delay-duration="200">
          <TooltipRoot>
            <TooltipTrigger as-child>
              <span class="cursor-help truncate text-[11px] text-white/72 underline decoration-dotted decoration-white/20 underline-offset-2">{{ spec.label }}</span>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                side="top" :side-offset="6" :collision-padding="8"
                class="pointer-events-none z-[200] max-w-[220px] rounded-md border border-white/10 bg-[#1b1b1f] px-2 py-1 text-[11px] leading-snug text-white/85 shadow-lg shadow-black/40"
              >{{ spec.hint }}</TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
        </TooltipProvider>
        <span v-else class="truncate text-[11px] text-white/72">{{ spec.label }}</span>
        <VariableGlyph
          v-if="bindable !== false && controlKindToVariableType(spec.kind)"
          :bound="bound ?? null"
          @promote="emit('promote')"
          @menu="(e: MouseEvent) => emit('menu', e)"
        />
        <!-- A control that belongs to the label rather than the value. The seed's
             randomise/lock toggle is the case: it acts on the row, it does not display the
             row's value, and sitting beside the number it competed with it for the one
             place the eye goes for a reading. -->
        <slot name="label-after" />
      </span>

      <span class="relative flex shrink-0 items-center gap-2" @dblclick.stop>
        <button
          v-if="bound"
          type="button"
          class="max-w-[100px] truncate font-mono text-[11px] underline decoration-dotted underline-offset-2"
          style="color: var(--var-accent-text)"
          :title="`${bound} — edit in table`"
          @pointerdown.stop
          @click.stop="emit('goToCollection')"
        >{{ bound }}</button>
        <!-- The value side carries a MINIMUM WIDTH, and it has to live here rather
             than in a renderer. Measured on the running panel: a numeric readout of
             `0` was 6.6px wide and a select's current option 36px, so the click
             target for typed entry and for the option menu was a few pixels of text.
             RowSelect cannot widen itself — its `absolute inset-0` overlay resolves
             against its own span, so stretching the target means stretching that
             span from outside, which is why the select renderer is a `flex-1` child
             of this box. For numeric rows the win is direct: this element owns the
             `pointerdown` that opens typed entry, so the whole 64px is clickable. -->
        <!-- `#value` overrides the registry for one row without inventing a ControlSpec
             kind. A node's seed is the case that forced it: an integer plus a lock/shuffle
             button, which is neither a slider (its 0..2^32 range fills no track) nor any
             other kind, and which would otherwise have to stay a two-line widget while
             every neighbour became a row. The slot sits INSIDE the min-width box so an
             overridden value keeps the same target size as a registry one. -->
        <span v-else data-row-value class="flex min-w-[64px] items-center justify-end gap-1" @pointerdown="onValuePointerDown">
          <slot name="value">
            <component
              v-if="renderer"
              :is="renderer"
              :value="modelValue"
              :spec="spec"
              :step="step"
              :editing="editing"
              @commit="onCommit"
              @cancel="onCancel"
              @update:value="(v: string | number | boolean) => emit('update:modelValue', v)"
            />
          </slot>
        </span>
      </span>
    </div>
    <slot name="body" />
  </div>
</template>
