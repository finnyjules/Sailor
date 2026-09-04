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
import { bandRect, moveBand, resizeBand, rulerTicks, snapSeconds, type TimelineView } from '~/lib/studio/moves/timelineDrag'
import type { MotionClip, Move } from '~/lib/studio/moves/types'

const props = defineProps<{
  clip: MotionClip
  selectedId: string | null
  playhead: number
  /** Row label for a move. Kept out of this file — a studio-specific label (Vector Type's `moveCardLabel`, etc.) is the caller's job. */
  label?: (m: Move) => string
  /** Transport state — drives the play/pause glyph in the ruler cluster. */
  playing?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'patch-move', move: Move, partial: Partial<Move>): void
  (e: 'seek', t: number): void
  (e: 'toggle-play'): void
}>()

/** Band whose ease trace is revealed on hover (selection also reveals it). */
const hoveredId = ref<string | null>(null)

/** Compact duration label shown inside a band: `0.5s`, `2s`, `1.3s`. */
function fmtDur(s: number): string {
  return s.toFixed(1).replace(/\.0$/, '') + 's'
}

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

// ---- ruler ticks (two-tier: labelled majors + unlabelled minors) ----------
const ticks = computed(() => rulerTicks(view.value, trackWidth.value))

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
      <div class="h-5"></div>
      <div v-for="m in props.clip.moves" :key="m.id" class="flex h-5 items-center">
        <span class="truncate text-[11px]" :class="m.id === props.selectedId ? 'text-white' : 'text-white/50'">{{ labelFor(m) }}</span>
      </div>
    </div>

    <!-- track column: ruler + band rows + playhead, all measured/positioned against THIS element -->
    <div ref="trackEl" class="relative flex min-w-0 flex-1 flex-col gap-1" data-track>
      <div
        class="relative h-5 cursor-crosshair rounded-t border-b border-white/10 bg-white/[0.02]"
        data-ruler
        @pointerdown="onRulerPointerDown"
      >
        <!-- Ticks styled like the studio slider's: one quiet 1px scale at 12%
             white (see StudioRow.vue's tickStyle), uniform major/minor — the
             mm:ss label alone marks the seconds, the marks are a ruler you read
             past, not a second row of UI. -->
        <!-- minor ticks (unlabelled, quarter subdivisions) -->
        <div
          v-for="tk in ticks.minor" :key="`mn-${tk.t}`"
          class="absolute inset-y-0 flex items-end"
          :style="{ left: `${tk.leftPct}%` }"
        >
          <span class="h-1.5 w-px bg-white/[0.12]"></span>
        </div>
        <!-- major ticks (mm:ss labelled) -->
        <div
          v-for="tk in ticks.major" :key="`mj-${tk.t}`"
          class="absolute inset-y-0 flex items-end"
          :style="{ left: `${tk.leftPct}%` }"
        >
          <span class="absolute bottom-[1px] left-0.5 whitespace-nowrap text-[9px] text-white/45">{{ tk.label }}</span>
          <span class="h-1.5 w-px bg-white/[0.12]"></span>
        </div>
        <!-- transport cluster (play/pause + reset zoom); pointerdown never starts a ruler seek/zoom -->
        <div
          class="absolute right-1 top-1/2 z-30 flex -translate-y-1/2 items-center gap-1.5"
          @pointerdown.stop
        >
          <button
            type="button"
            class="text-white/50 hover:text-white/85"
            :title="props.playing ? 'Pause' : 'Play'"
            @click.stop="emit('toggle-play')"
          >
            <svg v-if="props.playing" width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <rect x="2.5" y="2" width="2.5" height="8" rx="0.5" />
              <rect x="7" y="2" width="2.5" height="8" rx="0.5" />
            </svg>
            <svg v-else width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M3 2.2v7.6a.5.5 0 0 0 .77.42l6-3.8a.5.5 0 0 0 0-.84l-6-3.8A.5.5 0 0 0 3 2.2Z" />
            </svg>
          </button>
          <button
            type="button"
            class="text-white/50 hover:text-white/85"
            title="Reset zoom"
            @click.stop="resetView()"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9.5 6a3.5 3.5 0 1 1-1.03-2.47" />
              <path d="M9 1.8V3.8H7" />
            </svg>
          </button>
        </div>
      </div>

      <div
        v-for="(m, idx) in props.clip.moves" :key="m.id"
        class="relative h-5 cursor-pointer overflow-hidden rounded border border-white/[0.06]"
        :class="idx % 2 === 0 ? 'bg-white/[0.03]' : 'bg-white/[0.015]'"
        @click="emit('select', m.id)"
        @pointerenter="hoveredId = m.id"
        @pointerleave="hoveredId = null"
      >
        <template v-if="rectFor(m).widthPct > 0">
          <div
            class="absolute inset-y-0 overflow-hidden rounded-[3px] cursor-grab active:cursor-grabbing"
            :class="[
              m.id === props.selectedId
                ? 'bg-action text-white shadow-[0_1px_3px_rgba(0,0,0,0.35)]'
                : (m.loop ? 'bg-white/55 text-[#14171d]' : 'bg-white/80 text-[#14171d]'),
            ]"
            :style="{ left: `${rectFor(m).leftPct}%`, width: `${rectFor(m).widthPct}%` }"
            @pointerdown="onBandPointerDown($event, m)"
          >
            <!-- ease trace, one per visible cycle — drawn only when the band is selected or hovered -->
            <template v-if="m.id === props.selectedId || m.id === hoveredId">
              <svg
                v-for="(c, ci) in cyclesFor(m)" :key="ci"
                class="pointer-events-none absolute inset-y-0"
                :style="{ left: `${c.leftPct}%`, width: `${c.widthPct}%` }"
                viewBox="0 0 100 24" preserveAspectRatio="none"
              >
                <path
                  :d="easeGlyphPath(m.ease, 100, 24)" fill="none" stroke-width="1.5"
                  :stroke="m.id === props.selectedId ? 'white' : 'black'"
                  :stroke-opacity="m.id === props.selectedId ? 0.7 : 0.35"
                />
              </svg>
            </template>
            <!-- cycle dividers (always on — they define loop cycles) -->
            <div
              v-for="(c, ci) in cyclesFor(m).slice(0, -1)" :key="`div-${ci}`"
              class="pointer-events-none absolute inset-y-0 w-px bg-black/30"
              :style="{ left: `${c.leftPct + c.widthPct}%` }"
            ></div>
            <!-- duration label, centred over the first cycle; hidden when that cycle's real pixel
                 width is too narrow. cyclesFor() is band-LOCAL %, so scale by the band's own
                 track fraction (rectFor.widthPct) to get true px, else narrow bands never hide it. -->
            <div
              v-if="cyclesFor(m)[0] && (rectFor(m).widthPct / 100) * (cyclesFor(m)[0]!.widthPct / 100) * trackWidth >= 30"
              class="pointer-events-none absolute inset-y-0 flex items-center justify-center text-[10px] font-medium tabular-nums"
              :class="m.id === props.selectedId ? 'text-white/90' : 'text-black/55'"
              :style="{ left: `${cyclesFor(m)[0]!.leftPct}%`, width: `${cyclesFor(m)[0]!.widthPct}%` }"
            >{{ fmtDur(m.duration) }}</div>
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
