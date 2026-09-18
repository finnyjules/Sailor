<script setup lang="ts">
/** Docked motion timeline (3D Studio band idiom): transport row + a ruler +
 *  one band row per local layer. Bands mutate layer.animation in place during
 *  a drag (reactive re-render), then emit 'commit' on pointerup so the modal
 *  records history. All coords are seconds; bands render as % of duration. */
import type { FrameMotion } from '~/lib/motion/types'
import { createLayerAnimation } from '~/lib/motion/types'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import {
  bandSegments, setClipOffset, resizeTransition, setWindowDuration, snapSeconds, windowSeconds,
} from '~/lib/motion/timelineBands'
import { Play, Pause, Plus } from 'lucide-vue-next'

const props = defineProps<{
  layers: LocalLayer[]
  selectedId: string | null
  motion: FrameMotion
  t: number | null
  playing: boolean
  baking?: boolean
  bakeProgress?: number
  stale?: boolean
  bakeError?: string | null
}>()
const emit = defineEmits<{
  select: [id: string]
  play: []
  pause: []
  scrub: [t: number]
  'update:motion': [patch: Partial<FrameMotion>]
  bake: []
  commit: []
  beforeChange: []
}>()

const dur = computed(() => props.motion.duration)
const pct = (f: number) => `${(f * 100).toFixed(3)}%`
const rowLabel = (l: LocalLayer) =>
  (l as { name?: string }).name || (l.kind === 'text' ? ((l as { text?: string }).text?.split('\n')[0] || 'Text') : l.kind)
const seg = (l: LocalLayer) => bandSegments(l.animation, dur.value)

function addMotion(l: LocalLayer) {
  emit('beforeChange')
  if (!l.animation) l.animation = createLayerAnimation()
  emit('select', l.id)
  emit('commit')
}

// ── Drag listener cleanup: guards against the panel unmounting mid-drag ─────
let activeCleanup: (() => void) | null = null
onScopeDispose(() => activeCleanup?.())

// ── Ruler scrub ──────────────────────────────────────────────────────────────
const rulerEl = ref<HTMLElement | null>(null)
function rulerT(e: PointerEvent): number {
  const r = rulerEl.value!.getBoundingClientRect()
  return Math.max(0, Math.min(dur.value, ((e.clientX - r.left) / r.width) * dur.value))
}
function onRulerDown(e: PointerEvent) {
  emit('pause')
  emit('scrub', rulerT(e))
  const move = (ev: PointerEvent) => emit('scrub', rulerT(ev))
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); activeCleanup = null }
  activeCleanup = up
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// ── Band drags: 'offset' | 'in' | 'out' | 'end' ─────────────────────────────
function startDrag(e: PointerEvent, l: LocalLayer, mode: 'offset' | 'in' | 'out' | 'end') {
  emit('beforeChange')
  const anim = l.animation
  if (!anim) return
  emit('select', l.id)
  const track = (e.currentTarget as HTMLElement).closest('[data-band-track]') as HTMLElement
  const trackW = track.clientWidth
  const startX = e.clientX
  const startVal = mode === 'offset' ? anim.offset
    : mode === 'in' ? (anim.in?.duration ?? 0)
    : mode === 'out' ? (anim.out?.duration ?? 0)
    : windowSeconds(anim, dur.value).end - windowSeconds(anim, dur.value).start
  const snaps = [0, dur.value / 2, dur.value, ...(props.t != null ? [props.t] : [])]
  const move = (ev: PointerEvent) => {
    const ds = ((ev.clientX - startX) / trackW) * dur.value
    let next = startVal + (mode === 'out' ? -ds : ds)   // out divider grows leftward
    if (mode === 'offset') { next = snapSeconds(next, snaps); setClipOffset(anim, next, dur.value) }
    else if (mode === 'end') { next = snapSeconds(anim.offset + next, snaps) - anim.offset; setWindowDuration(anim, next, dur.value) }
    else if (mode === 'in') { next = snapSeconds(anim.offset + next, snaps) - anim.offset; resizeTransition(anim, mode, next, dur.value) }
    else if (mode === 'out') {
      const wEnd = windowSeconds(anim, dur.value).end
      next = wEnd - snapSeconds(wEnd - next, snaps)
      resizeTransition(anim, mode, next, dur.value)
    }
  }
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
    activeCleanup = null
    emit('commit')
  }
  activeCleanup = up
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
function resetWindowEnd(l: LocalLayer) {
  if (!l.animation) return
  emit('beforeChange')
  l.animation.duration = undefined
  emit('commit')
}
</script>

<template>
  <div class="rounded-[12px] border border-[#2a2a2a] bg-[#1a1a1a]/95 p-2.5 shadow-lg text-xs text-white/70">
    <!-- Transport row -->
    <div class="mb-2 flex items-center gap-2 text-[11px]">
      <button class="w-7 h-7 grid place-items-center rounded cursor-pointer hover:bg-white/10 text-white/85"
        :title="playing ? 'Pause' : 'Play'" @click="playing ? emit('pause') : emit('play')">
        <component :is="playing ? Pause : Play" class="size-3.5" />
      </button>
      <span class="tabular-nums text-white/60">{{ (t ?? 0).toFixed(2) }} / {{ motion.duration.toFixed(1) }}s</span>
      <div class="flex-1" />
      <label class="flex items-center gap-1">dur
        <input v-scrubnum type="number" min="0.5" max="60" step="0.5" :value="motion.duration"
          class="w-14 bg-[#111] border border-[#2a2a2a] rounded px-1 py-0.5 text-white/90 outline-none"
          @change="emit('update:motion', { duration: Math.max(0.5, Number(($event.target as HTMLInputElement).value) || 4) })">
      </label>
      <label class="flex items-center gap-1">fps
        <input v-scrubnum type="number" min="1" max="60" step="1" :value="motion.fps"
          class="w-12 bg-[#111] border border-[#2a2a2a] rounded px-1 py-0.5 text-white/90 outline-none"
          @change="emit('update:motion', { fps: Math.max(1, Math.min(60, Number(($event.target as HTMLInputElement).value) || 30)) })">
      </label>
      <span v-if="bakeError" class="max-w-[180px] truncate text-rose-400" :title="bakeError">{{ bakeError }}</span>
      <button class="px-2 py-0.5 rounded font-medium cursor-pointer"
        :class="stale ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30' : 'bg-white/15 text-white/70 hover:bg-white/20'"
        :disabled="baking" :title="stale ? 'Layers changed since last bake' : 'Bake motion to frames'"
        @click="emit('bake')">
        {{ baking ? `Baking ${Math.round((bakeProgress ?? 0) * 100)}%` : stale ? 'Re-bake' : 'Bake' }}
      </button>
    </div>

    <!-- Ruler + playhead + rows share one horizontal scale via the grid column;
         only this block scrolls — the transport row above stays pinned. -->
    <div class="max-h-[32vh] overflow-y-auto">
    <div class="grid grid-cols-[96px_1fr] gap-x-2">
      <div /><!-- ruler spacer over labels -->
      <div ref="rulerEl" class="relative h-4 cursor-ew-resize select-none" @pointerdown.stop.prevent="onRulerDown">
        <div class="absolute inset-x-0 bottom-0 h-px bg-white/15" />
        <span class="absolute left-0 bottom-1 text-[9px] text-white/30">0</span>
        <span class="absolute right-0 bottom-1 text-[9px] text-white/30">{{ motion.duration.toFixed(1) }}s</span>
      </div>

      <template v-for="l in layers" :key="l.id">
        <button class="truncate text-left text-[11px] cursor-pointer"
          :class="l.id === selectedId ? 'text-white' : 'text-white/50 hover:text-white/75'"
          @click="emit('select', l.id)">{{ rowLabel(l) }}</button>
        <div data-band-track class="relative my-0.5 h-5 overflow-hidden rounded border border-white/10 bg-white/[0.03]">
          <template v-if="l.animation">
            <!-- band: in (amber) / loop (emerald) / out (amber), draggable body + edges -->
            <div class="absolute inset-y-0 cursor-grab active:cursor-grabbing"
              :style="{ left: pct(seg(l).offset), width: pct(seg(l).end - seg(l).offset) }"
              @pointerdown.stop.prevent="(e: PointerEvent) => startDrag(e, l, 'offset')">
              <div v-if="l.animation.in" class="absolute inset-y-0 left-0 bg-amber-400/70" :style="{ width: pct(seg(l).in / Math.max(1e-6, seg(l).end - seg(l).offset)) }" />
              <div class="absolute inset-y-0 bg-emerald-400/60"
                :style="{ left: pct(seg(l).in / Math.max(1e-6, seg(l).end - seg(l).offset)), right: pct(seg(l).out / Math.max(1e-6, seg(l).end - seg(l).offset)) }" />
              <div v-if="l.animation.out" class="absolute inset-y-0 right-0 bg-amber-400/70" :style="{ width: pct(seg(l).out / Math.max(1e-6, seg(l).end - seg(l).offset)) }" />
            </div>
            <!-- divider + end handles (absolute in track space) -->
            <div v-if="l.animation.in" class="absolute inset-y-0 w-2 -ml-1 cursor-ew-resize z-10"
              :style="{ left: pct(seg(l).offset + seg(l).in) }"
              @pointerdown.stop.prevent="(e: PointerEvent) => startDrag(e, l, 'in')" />
            <div v-if="l.animation.out" class="absolute inset-y-0 w-2 -ml-1 cursor-ew-resize z-10"
              :style="{ left: pct(seg(l).end - seg(l).out) }"
              @pointerdown.stop.prevent="(e: PointerEvent) => startDrag(e, l, 'out')" />
            <div class="absolute inset-y-0 w-2 -ml-1 cursor-ew-resize z-10"
              :title="l.animation.duration == null ? 'Window: to end' : 'Drag to resize · double-click = to end'"
              :style="{ left: pct(seg(l).end) }"
              @pointerdown.stop.prevent="(e: PointerEvent) => startDrag(e, l, 'end')"
              @dblclick.stop="resetWindowEnd(l)" />
          </template>
          <button v-else class="absolute inset-0 flex items-center justify-center gap-1 text-[10px] text-white/30 hover:text-white/70 cursor-pointer"
            @click="addMotion(l)"><Plus class="size-3" /> add motion</button>
          <!-- playhead -->
          <div v-if="t != null" class="absolute inset-y-0 w-px bg-white/80 pointer-events-none z-20"
            :style="{ left: pct(Math.min(1, (t ?? 0) / motion.duration)) }" />
        </div>
      </template>
    </div>
    </div>
  </div>
</template>
