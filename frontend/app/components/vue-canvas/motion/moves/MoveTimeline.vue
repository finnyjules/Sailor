<script setup lang="ts">
/**
 * The shared moves timeline — DialKit's interaction model (seconds ruler,
 * scrubable playhead, drag-to-place/resize bands, ease drawn inside each
 * band), built native over the shared `Move`/`MotionClip` model instead of
 * embedding the DialKit library (see
 * `docs/superpowers/specs/2026-09-04-motion-timeline-design.md` §"Why not
 * embed the DialKit library"). Studio-agnostic: a studio supplies a `label`
 * function for each move's row name and reads `patch-move`/`select`/`seek`
 * back — nothing here knows what a "Vector Type" or "Shape" move is.
 *
 * Layout: a fixed label gutter (left) beside a single flex-1 "track"
 * column (right) that holds the ruler and every band row, in that same
 * stacked order, sharing one row-height/gap so labels line up with their
 * bands with no offset arithmetic. `trackEl` (the track column itself, not
 * a wrapper that also contains the label gutter) is what `ResizeObserver`
 * measures and what pointer math converts px↔seconds against — unlike
 * `Scene3DMotionTimeline.vue`, which measures its whole label+track row and
 * accepts the small resulting skew, this component's track column IS the
 * real draggable width, so the conversion is exact.
 *
 * The band-drag math itself lives in `~/lib/studio/moves/timelineDrag.ts`
 * (pure, unit-tested) — this component is the pointer-event/DOM wiring
 * around it.
 *
 * NOTHING here may import from `lib/vectortype`.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { easeGlyphPath } from '~/lib/studio/moves/ease'
import { bandRect, moveBand, resizeBand, snapSeconds, type TimelineView } from '~/lib/studio/moves/timelineDrag'
import type { MotionClip, Move } from '~/lib/studio/moves/types'

const props = defineProps<{
  clip: MotionClip
  selectedId: string | null
  playhead: number
  /** Row label for a move. Kept out of this file — a studio-specific label (Vector Type's `moveCardLabel`, etc.) is the caller's job. */
  label?: (m: Move) => string
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'patch-move', move: Move, partial: Partial<Move>): void
  (e: 'seek', t: number): void
}>()

const MIN_DURATION = 0.05

// ---- track width (px→seconds conversion + tick density) ----------------
const trackEl = ref<HTMLElement | null>(null)
const trackWidth = ref(1)
let ro: ResizeObserver | null = null
onMounted(() => {
  if (trackEl.value) trackWidth.value = trackEl.value.clientWidth || 1
  if (typeof ResizeObserver !== 'undefined' && trackEl.value) {
    ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) trackWidth.value = w
    })
    ro.observe(trackEl.value)
  }
})
onBeforeUnmount(() => ro?.disconnect())

// ---- zoom window (component-local, never persisted) ---------------------
const clipDuration = computed(() => Math.max(0.001, props.clip.duration))
const view = ref<TimelineView>({ start: 0, end: clipDuration.value })
watch(clipDuration, (d) => {
  // Keep the current window inside the (possibly changed) clip length
  // rather than resetting the user's zoom on every unrelated edit.
  const start = Math.max(0, Math.min(view.value.start, Math.max(0, d - 0.1)))
  const end = Math.max(start + 0.1, Math.min(view.value.end, d))
  view.value = { start, end }
})

function resetView() { view.value = { start: 0, end: clipDuration.value } }

function labelFor(m: Move): string {
  return props.label?.(m) ?? m.presetId ?? m.kind
}

function pxToSec(dxPx: number): number {
  const viewLen = view.value.end - view.value.start
  return (dxPx / Math.max(1, trackWidth.value)) * viewLen
}

function clientXToTime(clientX: number): number {
  const rect = trackEl.value?.getBoundingClientRect()
  if (!rect) return view.value.start
  const frac = (clientX - rect.left) / Math.max(1, rect.width)
  return view.value.start + frac * (view.value.end - view.value.start)
}

function clampTime(t: number): number {
  return Math.max(0, Math.min(clipDuration.value, t))
}

// ---- ruler ticks ----------------------------------------------------------
const NICE_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
const ticks = computed(() => {
  const viewLen = Math.max(0.001, view.value.end - view.value.start)
  const secPerPx = viewLen / Math.max(1, trackWidth.value)
  const rawStep = secPerPx * 56 // ~56px between labeled ticks
  const step = NICE_STEPS.find(s => s >= rawStep) ?? NICE_STEPS[NICE_STEPS.length - 1]!
  const out: { t: number; leftPct: number; label: string }[] = []
  const first = Math.ceil(view.value.start / step) * step
  for (let t = first; t <= view.value.end + 1e-6; t += step) {
    const leftPct = ((t - view.value.start) / viewLen) * 100
    out.push({ t, leftPct, label: `${t.toFixed(step < 1 ? 1 : 0)}s` })
  }
  return out
})

const playheadPct = computed(() => {
  const viewLen = Math.max(0.001, view.value.end - view.value.start)
  return Math.max(0, Math.min(100, ((props.playhead - view.value.start) / viewLen) * 100))
})

// ---- ruler drag: seek (plain) / zoom (alt) / reset (shift) --------------
let rulerMode: 'seek' | 'zoom' | null = null
let rulerStartX = 0
let rulerStartView: TimelineView = { start: 0, end: 0 }
let rulerStartTime = 0

function onRulerPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  if (e.shiftKey) { resetView(); return }
  rulerStartX = e.clientX
  rulerStartView = { ...view.value }
  rulerStartTime = clientXToTime(e.clientX)
  rulerMode = e.altKey ? 'zoom' : 'seek'
  if (rulerMode === 'seek') emit('seek', clampTime(rulerStartTime))
  window.addEventListener('pointermove', onRulerPointerMove)
  window.addEventListener('pointerup', onRulerPointerUp)
}

function onRulerPointerMove(e: PointerEvent) {
  if (rulerMode === 'seek') {
    emit('seek', clampTime(clientXToTime(e.clientX)))
    return
  }
  if (rulerMode === 'zoom') {
    const dx = e.clientX - rulerStartX
    // Drag right = zoom in (shrink the window around the gesture's start time); left = zoom out.
    const factor = Math.pow(2, -dx / 160)
    const startLen = Math.max(0.001, rulerStartView.end - rulerStartView.start)
    const minLen = Math.min(0.5, clipDuration.value)
    const newLen = Math.max(minLen, Math.min(clipDuration.value, startLen * factor))
    let start = rulerStartTime - (rulerStartTime - rulerStartView.start) * (newLen / startLen)
    start = Math.max(0, Math.min(clipDuration.value - newLen, start))
    view.value = { start, end: start + newLen }
  }
}

function onRulerPointerUp() {
  rulerMode = null
  window.removeEventListener('pointermove', onRulerPointerMove)
  window.removeEventListener('pointerup', onRulerPointerUp)
}

// ---- band geometry ----------------------------------------------------
function rectFor(m: Move) { return bandRect(m, view.value, clipDuration.value) }

function localPct(t: number, rect: { leftPct: number; widthPct: number }): number {
  const viewLen = Math.max(0.001, view.value.end - view.value.start)
  const fullPct = ((t - view.value.start) / viewLen) * 100
  if (rect.widthPct <= 0) return 0
  return ((fullPct - rect.leftPct) / rect.widthPct) * 100
}

/** For a loop band, the cycle boundaries visible in the current view — used for dividers and to tile the ease trace. A transition is a single "cycle" spanning its own full band. */
function cyclesFor(m: Move): { leftPct: number; widthPct: number }[] {
  const rect = rectFor(m)
  if (rect.widthPct <= 0) return []
  if (!m.loop) return [{ leftPct: 0, widthPct: 100 }]
  const dur = Math.max(MIN_DURATION, m.duration)
  const out: { leftPct: number; widthPct: number }[] = []
  let t = m.at
  let guard = 0
  while (t < clipDuration.value - 1e-6 && guard < 400) {
    const cycleEnd = Math.min(t + dur, clipDuration.value)
    const l = Math.max(0, localPct(t, rect))
    const r = Math.min(100, localPct(cycleEnd, rect))
    if (r > l) out.push({ leftPct: l, widthPct: r - l })
    t += dur
    guard++
  }
  return out
}

/** Local (0..100, relative to the band's own rect) position of a loop band's first cycle boundary — where the cycle-length drag handle sits. */
function firstCycleLocalPct(m: Move): number {
  return localPct(m.at + Math.max(MIN_DURATION, m.duration), rectFor(m))
}

function snapTargetsFor(m: Move): number[] {
  const targets = [0, clipDuration.value, props.playhead]
  for (const other of props.clip.moves) {
    if (other.id === m.id) continue
    targets.push(other.at)
    targets.push(other.loop ? clipDuration.value : other.at + other.duration)
  }
  return targets
}

// ---- band body drag: change `at` -----------------------------------------
function onBandPointerDown(e: PointerEvent, m: Move) {
  if (e.button !== 0) return
  e.stopPropagation()
  const startX = e.clientX
  const startAt = m.at
  const targets = snapTargetsFor(m)
  const onMove = (ev: PointerEvent) => {
    const deltaSec = pxToSec(ev.clientX - startX)
    const at = snapSeconds(moveBand(startAt, deltaSec, clipDuration.value), targets)
    emit('patch-move', m, { at })
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

// ---- edge drag: change `duration` (left edge also shifts `at`) ----------
function onEdgePointerDown(e: PointerEvent, m: Move, edge: 'left' | 'right') {
  e.stopPropagation()
  e.preventDefault()
  const startX = e.clientX
  const startBand = { at: m.at, duration: m.duration }
  const targets = snapTargetsFor(m)
  const onMove = (ev: PointerEvent) => {
    const deltaSec = pxToSec(ev.clientX - startX)
    const resized = resizeBand(startBand, edge, deltaSec, clipDuration.value)
    if (edge === 'right') {
      const snappedEnd = snapSeconds(resized.at + resized.duration, targets)
      emit('patch-move', m, { duration: Math.max(MIN_DURATION, snappedEnd - resized.at) })
    } else {
      const snappedAt = snapSeconds(resized.at, targets)
      const duration = Math.max(MIN_DURATION, (startBand.at + startBand.duration) - snappedAt)
      emit('patch-move', m, { at: snappedAt, duration })
    }
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
</script>

<template>
  <div class="flex select-none gap-2">
    <!-- label gutter: one entry per row, same order/height/gap as the track column so rows line up -->
    <div class="flex w-24 shrink-0 flex-col gap-1">
      <div class="h-[18px]"></div>
      <div v-for="m in props.clip.moves" :key="m.id" class="flex h-6 items-center">
        <span class="truncate text-[11px]" :class="m.id === props.selectedId ? 'text-white' : 'text-white/50'">{{ labelFor(m) }}</span>
      </div>
    </div>

    <!-- track column: ruler + band rows + playhead, all measured/positioned against THIS element -->
    <div ref="trackEl" class="relative flex min-w-0 flex-1 flex-col gap-1" data-track>
      <div
        class="relative h-[18px] cursor-crosshair rounded-t border-b border-white/10 bg-white/[0.02]"
        data-ruler
        @pointerdown="onRulerPointerDown"
      >
        <div
          v-for="tk in ticks" :key="tk.t"
          class="absolute inset-y-0 flex items-end"
          :style="{ left: `${tk.leftPct}%` }"
        >
          <span class="absolute bottom-[1px] left-0.5 whitespace-nowrap text-[9px] text-white/40">{{ tk.label }}</span>
          <span class="h-1.5 w-px bg-white/25"></span>
        </div>
      </div>

      <div
        v-for="m in props.clip.moves" :key="m.id"
        class="relative h-6 cursor-pointer overflow-hidden rounded border border-white/10 bg-white/[0.03]"
        @click="emit('select', m.id)"
      >
        <template v-if="rectFor(m).widthPct > 0">
          <div
            class="absolute inset-y-0 overflow-hidden rounded-[3px] cursor-grab active:cursor-grabbing"
            :class="[
              m.loop ? 'bg-emerald-400/60' : 'bg-amber-400/70',
              m.id === props.selectedId ? 'ring-2 ring-inset ring-blue-400' : '',
            ]"
            :style="{ left: `${rectFor(m).leftPct}%`, width: `${rectFor(m).widthPct}%` }"
            @pointerdown="onBandPointerDown($event, m)"
          >
            <!-- ease trace, one per visible cycle (a transition has exactly one) -->
            <svg
              v-for="(c, ci) in cyclesFor(m)" :key="ci"
              class="absolute inset-y-0 pointer-events-none opacity-50"
              :style="{ left: `${c.leftPct}%`, width: `${c.widthPct}%` }"
              viewBox="0 0 100 24" preserveAspectRatio="none"
            >
              <path :d="easeGlyphPath(m.ease, 100, 24)" fill="none" stroke="white" stroke-width="1.5" />
            </svg>
            <!-- cycle dividers -->
            <div
              v-for="(c, ci) in cyclesFor(m).slice(0, -1)" :key="`div-${ci}`"
              class="pointer-events-none absolute inset-y-0 w-px bg-black/30"
              :style="{ left: `${c.leftPct + c.widthPct}%` }"
            ></div>
          </div>

          <!-- edge handles: transition gets both; a loop only gets a cycle-length handle at its first boundary -->
          <div
            v-if="!m.loop"
            class="absolute inset-y-0 z-10 w-2 -ml-1 cursor-ew-resize"
            :style="{ left: `${rectFor(m).leftPct}%` }"
            @pointerdown="onEdgePointerDown($event, m, 'left')"
          ></div>
          <div
            class="absolute inset-y-0 z-10 w-2 -ml-1 cursor-ew-resize"
            :style="m.loop
              ? { left: `calc(${rectFor(m).leftPct}% + ${(firstCycleLocalPct(m) / 100) * rectFor(m).widthPct}%)` }
              : { left: `${rectFor(m).leftPct + rectFor(m).widthPct}%` }"
            @pointerdown="onEdgePointerDown($event, m, 'right')"
          ></div>
        </template>
      </div>

      <div v-if="props.clip.moves.length === 0" class="py-3 text-center text-[11px] text-white/30">No moves yet</div>

      <!-- playhead -->
      <div
        class="pointer-events-none absolute inset-y-0 z-20 w-px bg-white"
        :style="{ left: `${playheadPct}%` }"
      ></div>
    </div>
  </div>
</template>
