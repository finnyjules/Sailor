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
import {
  effectDialTargets, evaluateDialTrack, addKeyframe, moveKeyframe, removeKeyframe,
  setTrack, removeDialTrack, isGradientValue, type EffectDialTrack, type DialKeyframe,
} from '~/lib/motion/effectTracks'
import { Play, Pause, Plus } from 'lucide-vue-next'
import GradientEditor from '~/components/vue-canvas/compositor/GradientEditor.vue'
import type { Gradient } from '~/lib/compositor/paint'

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

// ── Effect-dial keyframe rows (F8 Task 5) ────────────────────────────────────
// Per-dial tracks nested under each layer band. Every edit flows through the
// reactive path — emit('update:motion', { tracks }) then emit('commit') — never a
// raw mutation of props.motion (a raw doc write does not reach the mounted modal's
// paint). Keyframe positions are seconds→fraction via `pct`/`dur`, exactly like the
// bands, and the shared playhead is redrawn in each lane so a scrub lines up.
const tracksForLayer = (l: LocalLayer): EffectDialTrack[] =>
  (props.motion.tracks ?? []).filter((tk) => tk?.target?.startsWith(`layers.${l.id}.`))
// The dial's human name (Effect · Dial), falling back to the last path segment.
function dialLabel(l: LocalLayer, tk: EffectDialTrack): string {
  return effectDialTargets(l).find((d) => d.path === tk.target)?.label
    || tk.target.split('.').pop() || tk.target
}
// A DOM-safe id fragment for a dial target's data-testid — mirrors the modal's
// dialTestKey() convention (dots/colons flattened) so tests address either UI.
const dialTestKey = (target: string) => target.replace(/[^a-z0-9]+/gi, '-')

// Drag a keyframe diamond horizontally to change its time. Mirrors the band drag
// idiom (beforeChange on down, window listeners, activeCleanup, commit on up), but
// mutates via the setTrack/moveKeyframe reducers through emit('update:motion').
function startKfDrag(e: PointerEvent, tk: EffectDialTrack, i: number) {
  emit('beforeChange')
  const lane = (e.currentTarget as HTMLElement).closest('[data-dial-lane]') as HTMLElement
  const r = lane.getBoundingClientRect()
  const move = (ev: PointerEvent) => {
    const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))
    const newT = frac * dur.value
    emit('update:motion', { tracks: setTrack(props.motion.tracks ?? [], tk.target, moveKeyframe(tk, i, newT)) })
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
// Click the empty lane to add a keyframe at that time, seeded with the dial's value
// there (the interpolated value, so the ramp is unchanged until the diamond moves).
function onLaneAdd(e: MouseEvent, tk: EffectDialTrack) {
  const lane = e.currentTarget as HTMLElement
  const r = lane.getBoundingClientRect()
  const t = Math.max(0, Math.min(dur.value, ((e.clientX - r.left) / r.width) * dur.value))
  const v = evaluateDialTrack(tk, t) ?? tk.keyframes[0]?.v ?? 0
  emit('beforeChange')
  emit('update:motion', { tracks: setTrack(props.motion.tracks ?? [], tk.target, addKeyframe(tk, t, v)) })
  emit('commit')
}
// Double-click a diamond to delete it; deleting the last keyframe drops the track.
function deleteKf(tk: EffectDialTrack, i: number) {
  emit('beforeChange')
  const tracks = props.motion.tracks ?? []
  const next = tk.keyframes.length <= 1
    ? removeDialTrack(tracks, tk.target)
    : setTrack(tracks, tk.target, removeKeyframe(tk, i))
  emit('update:motion', { tracks: next })
  emit('commit')
  if (selectedKf.value?.target === tk.target && selectedKf.value.index === i) selectedKf.value = null
}

// ── Gradient-lane keyframes (Plan 3 Task 6) ──────────────────────────────────
// A gradient dial's keyframes render as small gradient swatches instead of the
// amber diamond; clicking one selects it for editing below via GradientEditor.
function gradientSwatchCss(v: { pos: number; color: string }[]): string {
  const stops = v.map((s) => `${s.color} ${(s.pos * 100).toFixed(1)}%`).join(', ')
  return `linear-gradient(90deg, ${stops})`
}
const selectedKf = ref<{ target: string; index: number } | null>(null)
function selectKf(tk: EffectDialTrack, i: number) {
  selectedKf.value = { target: tk.target, index: i }
}
// The selected gradient keyframe, resolved live against props.motion so a drag/delete
// elsewhere keeps this in sync (or clears once it no longer resolves to a gradient).
const selectedKfEntry = computed<{ tk: EffectDialTrack; kf: DialKeyframe } | null>(() => {
  const sel = selectedKf.value
  if (!sel) return null
  const tk = (props.motion.tracks ?? []).find((t) => t.target === sel.target)
  const kf = tk?.keyframes[sel.index]
  if (!tk || !kf || !isGradientValue(kf.v)) return null
  return { tk, kf }
})
const DEFAULT_GRADIENT: Gradient = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }
const selectedKeyframeGradient = computed<Gradient>(() => {
  const entry = selectedKfEntry.value
  if (!entry) return DEFAULT_GRADIENT
  const v = entry.kf.v as { pos: number; color: string }[]
  return { type: 'linear', angle: 0, stops: v.map((s) => ({ offset: s.pos, color: s.color })) }
})
function onSelectedKeyframeGradient(g: Gradient) {
  const entry = selectedKfEntry.value
  if (!entry) return
  const stops = g.stops.map((s) => ({ pos: s.offset, color: s.color }))
  emit('beforeChange')
  emit('update:motion', { tracks: setTrack(props.motion.tracks ?? [], entry.tk.target, addKeyframe(entry.tk, entry.kf.t, stops)) })
  emit('commit')
}
// Per-lane Mode (crossfade/travel) + Colour (oklab/hybrid) controls, shown only for
// a gradient-keyframed track.
function isGradientTrack(tk: EffectDialTrack): boolean {
  return isGradientValue(tk.keyframes[0]?.v)
}
function setTrackMode(tk: EffectDialTrack, mode: 'crossfade' | 'travel') {
  emit('beforeChange')
  emit('update:motion', { tracks: setTrack(props.motion.tracks ?? [], tk.target, { ...tk, mode }) })
  emit('commit')
}
function setTrackBlendSpace(tk: EffectDialTrack, blendSpace: 'oklab' | 'hybrid') {
  emit('beforeChange')
  emit('update:motion', { tracks: setTrack(props.motion.tracks ?? [], tk.target, { ...tk, blendSpace }) })
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

        <!-- Per-dial keyframe rows, nested under this layer's band (F8 Task 5) -->
        <template v-for="tk in tracksForLayer(l)" :key="tk.target">
          <span class="truncate text-left text-[10px] text-white/40 pl-3 self-center"
            :data-testid="'dial-track-' + dialTestKey(tk.target)"
            :title="dialLabel(l, tk)">{{ dialLabel(l, tk) }}</span>
          <div data-dial-lane :data-testid="'dial-lane-' + dialTestKey(tk.target)"
            class="relative my-0.5 h-4 rounded border border-white/[0.06] bg-white/[0.02] cursor-copy"
            title="Click to add a keyframe"
            @click="(e: MouseEvent) => onLaneAdd(e, tk)">
            <!-- Per-lane Mode/Colour control, only for a gradient-keyframed track -->
            <div v-if="isGradientTrack(tk)" class="absolute -top-3.5 right-0 flex items-center gap-0.5 z-20" @click.stop>
              <button v-for="m in (['crossfade', 'travel'] as const)" :key="m"
                class="px-1 rounded-sm text-[8px] leading-4 cursor-pointer"
                :class="(tk.mode ?? 'crossfade') === m ? 'bg-white/20 text-white/85' : 'text-white/35 hover:text-white/60'"
                :title="m === 'crossfade' ? 'Crossfade' : 'Travel'"
                @click="setTrackMode(tk, m)">{{ m === 'crossfade' ? 'Cross' : 'Travel' }}</button>
              <button v-for="b in (['oklab', 'hybrid'] as const)" :key="b"
                class="px-1 rounded-sm text-[8px] leading-4 cursor-pointer"
                :class="(tk.blendSpace ?? 'oklab') === b ? 'bg-white/20 text-white/85' : 'text-white/35 hover:text-white/60'"
                :title="b === 'oklab' ? 'OKLab' : 'Hybrid'"
                @click="setTrackBlendSpace(tk, b)">{{ b === 'oklab' ? 'OKLab' : 'Hybrid' }}</button>
            </div>
            <template v-for="(kf, i) in tk.keyframes" :key="i">
              <div v-if="isGradientValue(kf.v)"
                :data-testid="'kf-' + i"
                class="absolute top-1/2 w-4 h-2.5 -ml-2 -mt-[5px] rounded-sm border border-white/40 cursor-ew-resize z-10 hover:border-white/70"
                :class="selectedKf?.target === tk.target && selectedKf?.index === i ? 'ring-1 ring-white' : ''"
                :style="{ left: pct(Math.min(1, kf.t / dur)), background: gradientSwatchCss(kf.v) }"
                title="Gradient keyframe · click to edit, drag to move, double-click to delete"
                @pointerdown.stop.prevent="(e: PointerEvent) => startKfDrag(e, tk, i)"
                @click.stop="selectKf(tk, i)"
                @dblclick.stop="() => deleteKf(tk, i)" />
              <div v-else
                :data-testid="'kf-' + i"
                class="absolute top-1/2 size-2 -ml-1 -mt-1 rotate-45 bg-amber-300 border border-amber-200/70 cursor-ew-resize z-10 hover:bg-amber-200"
                :style="{ left: pct(Math.min(1, kf.t / dur)) }"
                title="Keyframe · drag to move, double-click to delete"
                @pointerdown.stop.prevent="(e: PointerEvent) => startKfDrag(e, tk, i)"
                @click.stop
                @dblclick.stop="() => deleteKf(tk, i)" />
            </template>
            <!-- playhead across the dial lane, same scale as the band above -->
            <div v-if="t != null" class="absolute inset-y-0 w-px bg-white/80 pointer-events-none z-20"
              :style="{ left: pct(Math.min(1, (t ?? 0) / motion.duration)) }" />
          </div>
        </template>
      </template>
    </div>
    </div>

    <!-- Selected gradient keyframe: docked mini gradient editor -->
    <div v-if="selectedKfEntry" class="mt-2 border-t border-white/10 pt-2">
      <div class="mb-1 flex items-center justify-between text-[10px] text-white/40">
        <span>Gradient keyframe</span>
        <button class="cursor-pointer hover:text-white/70" @click="selectedKf = null">Done</button>
      </div>
      <GradientEditor :model-value="selectedKeyframeGradient" @update:model-value="onSelectedKeyframeGradient" />
    </div>
  </div>
</template>
