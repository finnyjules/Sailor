<script setup lang="ts">
/** DialKit-style "everything is a band" motion timeline (Slice 6d). Emulates DialKit's
 *  timeline geometry + gestures (ruler with ticks, drag-seek playhead, alt-drag pivot zoom,
 *  shift-reset, wheel/scrollbar pan, DialKit row/clip dimensions, collapsible groups) —
 *  rendered in Sailor tokens (PP Neue Montreal + tabular-nums, compositor palette, #7c9cff
 *  accent, emerald behaviour bands, value-showing clip interiors). View math is the pure
 *  ~/lib/motionx/timelineView (ported from dialkit). motionx stays the source of truth. */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { Track, StoredBehaviour } from '~/lib/motionx'
import { bandsForLayer, behaviourBandsForLayer, numberBandCurve, colorBandCss, gradientBandCss, trackSpan, type Band } from '~/lib/motionx/bands'
import { animatableProperties } from '~/lib/motionx/adapter/frame'
import { shiftTrack, retimeTrack, movePoint, removePoint, setPointValue, setBandTrack } from '~/lib/motionx/bandEdit'
import { deriveView, timeToX, xToTime, zoomAboutPivot, clampViewStart, computeTicks, formatRulerSeconds, ghostCycles, type View } from '~/lib/motionx/timelineView'

export interface MotionSelection { kind: 'band' | 'point' | 'behaviour'; path: string; index?: number }

const props = defineProps<{
  layers: LocalLayer[]
  selectedId: string | null
  motionx: Track[]
  behaviours?: StoredBehaviour[]
  duration: number
  t: number | null
  selection: MotionSelection | null
  // Transport + actions (the dock header — DialKit has these on the section header)
  playing?: boolean
  fps?: number
  loop?: boolean
  baking?: boolean
  bakeProgress?: number
  stale?: boolean
  bakeError?: string | null
  galleryOpen?: boolean
  propertyPickerOpen?: boolean
}>()
const emit = defineEmits<{
  select: [id: string]
  'select-band': [path: string]
  'select-point': [sel: { path: string; index: number }]
  'select-behaviour': [id: string]
  'update:motionx': [tracks: Track[]]
  'before-change': []
  commit: []
  scrub: [t: number]
  pause: []
  play: []
  bake: []
  'update:motion': [patch: { duration?: number; fps?: number; loop?: boolean }]
  'toggle-gallery': []
  'toggle-property-picker': []
  // Behaviour bars: drag to move / drag edges to retime (DialKit clip gestures) + Open on the bar.
  'behaviour-change': [id: string, patch: { timing: { start?: number; duration?: number } }]
  'behaviour-open': [id: string]
}>()
const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// ── View state (component-local, DialKit idiom) ──────────────────────────────
const view = ref<View>({ zoom: 1, viewStart: 0 })
const laneEl = ref<HTMLElement | null>(null)
const laneWidth = ref(0)
let ro: ResizeObserver | null = null
onMounted(() => {
  if (!laneEl.value) return
  laneWidth.value = laneEl.value.clientWidth
  ro = new ResizeObserver(() => { laneWidth.value = laneEl.value?.clientWidth ?? 0 })
  ro.observe(laneEl.value)
})
onBeforeUnmount(() => ro?.disconnect())
const dv = computed(() => deriveView(view.value, props.duration, laneWidth.value))
const ticks = computed(() => computeTicks(dv.value, view.value.zoom, props.duration))
const xOf = (time: number) => timeToX(time, dv.value)
const wOf = (a: number, b: number) => Math.max(2, (b - a) * dv.value.pxPerSecond)
const px = (n: number) => `${n}px`
const playheadX = computed(() => xOf(props.t ?? 0))
const playheadVisible = computed(() =>
  props.t != null && props.t >= dv.value.safeViewStart - 1e-6 && props.t <= dv.value.viewEnd + 1e-6 && laneWidth.value > 0)
// DialKit keeps the 52px time flag fully inside the lane (its centre is clamped).
const FLAG_W = 52
const flagX = computed(() => clampN(playheadX.value, FLAG_W / 2, Math.max(FLAG_W / 2, laneWidth.value - FLAG_W / 2)))

const rowLabel = (l: LocalLayer) =>
  (l as { name?: string }).name || (l.kind === 'text' ? ((l as { text?: string }).text?.split('\n')[0] || 'Text') : l.kind)

// ── Layer groups (each layer is a collapsible header; its behaviours + property
//    bands are the rows under it — DialKit's clip-per-row model). ──────────────
const collapsedLayers = ref<Set<string>>(new Set())
function toggleLayer(id: string) {
  const s = new Set(collapsedLayers.value)
  s.has(id) ? s.delete(id) : s.add(id)
  collapsedLayers.value = s
}
const behBandsFor = (layerId: string) => behaviourBandsForLayer(layerId, props.behaviours ?? [], props.motionx)
// A looping bar is ONE cycle; these are its faint repeats out to the end of the timeline.
const ghostsOf = (b: Band) => (b.loop ? ghostCycles(b.start, b.end - b.start, props.duration, dv.value.safeViewStart) : [])
// A loop owns its property from its start to the END of the timeline, not just its bar.
const reachOf = (b: Band) => (b.loop ? Math.max(b.end, props.duration) : b.end)
// Property bands for any layer (untagged tracks), each its own row.
function propBandsFor(l: LocalLayer): Band[] {
  const m = new Map<string, string>()
  for (const p of animatableProperties(l)) m.set(p.path, p.label)
  return bandsForLayer(l.id, props.motionx, (p) => m.get(p) ?? '')
}
const rowCountFor = (l: LocalLayer) => behBandsFor(l.id).length + propBandsFor(l).length

// ── Rows keyed by PROPERTY (one behaviour = one property). A row holds every bar that
//    drives that property: behaviour bars + the explicit property band. Two bars whose
//    spans overlap in the same row are a genuine clash → flagged. ─────────────────────
interface PropertyRow { path: string; label: string; behaviours: Band[]; property: Band | null; conflicts: Set<string> }
function rowsFor(l: LocalLayer): PropertyRow[] {
  const labels = new Map(animatableProperties(l).map((p) => [p.path, p.label] as const))
  const order = [...labels.keys()]
  const byPath = new Map<string, PropertyRow>()
  const row = (path: string) => {
    let r = byPath.get(path)
    if (!r) { r = { path, label: labels.get(path) ?? path.split('.').pop() ?? path, behaviours: [], property: null, conflicts: new Set() }; byPath.set(path, r) }
    return r
  }
  for (const b of behBandsFor(l.id)) {
    const tk = props.motionx.find((t) => t.behaviourId === b.behaviourId)
    if (tk) row(tk.path).behaviours.push(b)
  }
  for (const b of propBandsFor(l)) row(b.path).property = b
  const rows = [...byPath.values()].sort((a, b) => {
    const ia = order.indexOf(a.path), ib = order.indexOf(b.path)
    return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib)
  })
  for (const r of rows) {
    const bars = [...r.behaviours, ...(r.property ? [r.property] : [])]
    for (let i = 0; i < bars.length; i++) for (let j = i + 1; j < bars.length; j++) {
      const a = bars[i]!, b = bars[j]!
      if (Math.min(reachOf(a), reachOf(b)) - Math.max(a.start, b.start) > 1e-6) { r.conflicts.add(a.key); r.conflicts.add(b.key) }
    }
  }
  return rows
}
const isBehSel = (b: Band) => props.selection?.kind === 'behaviour' && props.selection.path === b.behaviourId

const trackByPath = (path: string) => props.motionx.find((t) => t.path === path)
const pointX = (b: Band, t: number) => {
  const s = b.end - b.start
  return s < 1e-9 ? 0 : (t - b.start) / s
}
const pctX = (f: number) => `${(Math.max(0, Math.min(1, f)) * 100).toFixed(3)}%`
function curvePoints(b: Band): string {
  const tk = trackByPath(b.path)
  if (!tk) return ''
  return numberBandCurve(tk).map((p) => `${(p.x * 100).toFixed(2)},${((1 - p.y) * 100).toFixed(2)}`).join(' ')
}
function bandCss(b: Band): string {
  const tk = trackByPath(b.path)
  if (!tk) return 'transparent'
  return b.kind === 'color' ? colorBandCss(tk) : b.kind === 'gradient' ? gradientBandCss(tk) : 'transparent'
}
const isBandSel = (b: Band) => props.selection?.kind === 'band' && props.selection.path === b.path
const isPointSel = (b: Band, i: number) =>
  props.selection?.kind === 'point' && props.selection.path === b.path && props.selection.index === i

// ── Drag plumbing ────────────────────────────────────────────────────────────
let activeCleanup: (() => void) | null = null
onScopeDispose(() => activeCleanup?.())
function drag(move: (e: PointerEvent) => void, onUp?: () => void) {
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); activeCleanup = null; onUp?.() }
  activeCleanup = up
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
}
// Map a clientX within a lane element to seconds in the CURRENT view.
function laneSeconds(el: HTMLElement, clientX: number): number {
  const r = el.getBoundingClientRect()
  return Math.max(0, Math.min(props.duration, xToTime(clientX - r.left, dv.value)))
}
function emitTrack(next: Track): void { emit('update:motionx', setBandTrack(props.motionx, next.path, next)) }

// ── Ruler: seek / shift-reset / alt-zoom ─────────────────────────────────────
function onRulerDown(e: PointerEvent) {
  if (!laneEl.value) return
  if (e.altKey) return onZoomDown(e)
  const rect = laneEl.value.getBoundingClientRect()
  const reset = e.shiftKey
  if (reset) view.value = { zoom: 1, viewStart: 0 }
  const base = reset
    ? { safeViewStart: 0, visibleDuration: props.duration }
    : { safeViewStart: dv.value.safeViewStart, visibleDuration: dv.value.visibleDuration }
  emit('pause')
  const seek = (clientX: number) => {
    const frac = (clientX - rect.left) / rect.width
    emit('scrub', Math.max(0, Math.min(props.duration, base.safeViewStart + frac * base.visibleDuration)))
  }
  seek(e.clientX)
  drag((ev) => seek(ev.clientX))
}
function onZoomDown(e: PointerEvent) {
  if (!laneEl.value) return
  const rect = laneEl.value.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const anchorTime = dv.value.safeViewStart + ratio * dv.value.visibleDuration
  const startX = e.clientX
  const startView = { ...view.value }
  let moved = false
  drag((ev) => {
    const dx = ev.clientX - startX
    if (!moved && Math.abs(dx) <= 3) return
    moved = true
    view.value = zoomAboutPivot(startView, props.duration, laneWidth.value, dx, ratio, anchorTime)
  })
}
// ── Pan: wheel + sticky scrollbar (zoom > 1) ─────────────────────────────────
function onWheel(e: WheelEvent) {
  if (view.value.zoom <= 1) return
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0)
  if (!delta) return
  e.preventDefault()
  const d = dv.value
  view.value = { ...view.value, viewStart: clampViewStart(d.safeViewStart + delta / d.pxPerSecond, props.duration, d.visibleDuration) }
}
const scrollEl = ref<HTMLElement | null>(null)
function onScroll(e: Event) {
  const d = dv.value
  if (d.pxPerSecond <= 0) return
  view.value = { ...view.value, viewStart: clampViewStart((e.target as HTMLElement).scrollLeft / d.pxPerSecond, props.duration, d.visibleDuration) }
}
watch(() => dv.value.safeViewStart, (vs) => {
  const el = scrollEl.value
  if (!el || dv.value.pxPerSecond <= 0) return
  const want = vs * dv.value.pxPerSecond
  if (Math.abs(el.scrollLeft - want) > 0.5) el.scrollLeft = want
})

// ── Popover dismissal (click outside the popover + its toggle buttons, or Escape) ──
const popoverEl = ref<HTMLElement | null>(null)
function closePopovers() {
  if (props.galleryOpen) emit('toggle-gallery')
  if (props.propertyPickerOpen) emit('toggle-property-picker')
}
function onDocPointerDown(e: PointerEvent) {
  if (!props.galleryOpen && !props.propertyPickerOpen) return
  const t = e.target as HTMLElement
  if (popoverEl.value?.contains(t) || t.closest('[data-testid="add-behaviour-toggle"],[data-testid="add-property-toggle"]')) return
  closePopovers()
}
function onDocKey(e: KeyboardEvent) { if (e.key === 'Escape') closePopovers() }
onMounted(() => { document.addEventListener('pointerdown', onDocPointerDown, true); document.addEventListener('keydown', onDocKey) })
onBeforeUnmount(() => { document.removeEventListener('pointerdown', onDocPointerDown, true); document.removeEventListener('keydown', onDocKey) })

// ── Behaviour bar gestures: move / retime edges; a click (no move) selects ───
function startBehDrag(e: PointerEvent, b: Band, mode: 'move' | 'start' | 'end') {
  const id = b.behaviourId!
  const startX = e.clientX
  const at0 = b.start, dur0 = b.end - b.start
  let moved = false
  emit('before-change')
  drag((ev) => {
    const dx = ev.clientX - startX
    if (!moved && Math.abs(dx) <= 3) return
    moved = true
    const dt = dx / Math.max(1e-6, dv.value.pxPerSecond)
    if (mode === 'move') {
      emit('behaviour-change', id, { timing: { start: clampN(at0 + dt, 0, Math.max(0, props.duration - dur0)) } })
    } else if (mode === 'end') {
      emit('behaviour-change', id, { timing: { duration: clampN(dur0 + dt, 0.05, Math.max(0.05, props.duration - at0)) } })
    } else {
      const s = clampN(at0 + dt, 0, at0 + dur0 - 0.05)
      emit('behaviour-change', id, { timing: { start: s, duration: at0 + dur0 - s } })
    }
  }, () => { if (moved) emit('commit'); else emit('select-behaviour', id) })
}

// ── Band edits (view-aware seconds) ──────────────────────────────────────────
function startShift(e: PointerEvent, b: Band) {
  const tk = trackByPath(b.path)
  if (!tk) return
  emit('select-band', b.path); emit('before-change')
  const startX = e.clientX
  drag((ev) => emitTrack(shiftTrack(tk, (ev.clientX - startX) / Math.max(1e-6, dv.value.pxPerSecond))),
    () => emit('commit'))
}
function startRetime(e: PointerEvent, b: Band, edge: 'start' | 'end') {
  const tk = trackByPath(b.path)
  if (!tk) return
  emit('select-band', b.path); emit('before-change')
  const lane = (e.currentTarget as HTMLElement).closest('[data-band-lane]') as HTMLElement
  drag((ev) => {
    const s = laneSeconds(lane, ev.clientX)
    const cur = trackSpan(trackByPath(b.path) ?? tk)
    emitTrack(edge === 'start' ? retimeTrack(tk, Math.min(s, cur.end - 0.05), cur.end) : retimeTrack(tk, cur.start, Math.max(s, cur.start + 0.05)))
  }, () => emit('commit'))
}
function startPointDrag(e: PointerEvent, b: Band, i: number) {
  const tk = trackByPath(b.path)
  if (!tk) return
  emit('select-point', { path: b.path, index: i }); emit('before-change')
  const lane = (e.currentTarget as HTMLElement).closest('[data-band-lane]') as HTMLElement
  let idx = i
  drag((ev) => {
    const res = movePoint(trackByPath(b.path) ?? tk, idx, laneSeconds(lane, ev.clientX))
    idx = res.index
    emit('update:motionx', setBandTrack(props.motionx, b.path, res.track))
    emit('select-point', { path: b.path, index: idx })
  }, () => emit('commit'))
}
function deletePoint(b: Band, i: number) {
  const tk = trackByPath(b.path)
  if (!tk) return
  emit('before-change')
  const next = removePoint(tk, i)
  emit('update:motionx', setBandTrack(props.motionx, b.path, next.keyframes.length ? next : null))
  emit('commit')
}

// ── Control-point popover ────────────────────────────────────────────────────
const selPointBand = computed<Band | null>(() => {
  if (props.selection?.kind !== 'point') return null
  const path = props.selection.path
  const m = path.match(/^layers\.([^.]+)\./)
  const l = m ? props.layers.find((x) => x.id === m[1]) : null
  return l ? (propBandsFor(l).find((b) => b.path === path) ?? null) : null
})
const selPointKf = computed(() => {
  const b = selPointBand.value, i = props.selection?.index
  return b && i != null ? b.keyframes[i] ?? null : null
})
function setSelPointValue(v: number | string) {
  const b = selPointBand.value, i = props.selection?.index, tk = b && trackByPath(b.path)
  if (!b || i == null || !tk) return
  emit('before-change')
  emit('update:motionx', setBandTrack(props.motionx, b.path, setPointValue(tk, i, v)))
  emit('commit')
}
</script>

<template>
  <div class="relative rounded-[14px] border border-white/10 bg-[#1a1a1a]/95 p-2.5 text-xs text-white/70 font-[var(--font-sans)]" data-testid="band-timeline" @wheel="onWheel">
    <!-- Dock header: transport on the left, actions on the right (DialKit section header) -->
    <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] whitespace-nowrap">
      <button type="button" class="w-7 h-7 shrink-0 grid place-items-center rounded-md cursor-pointer hover:bg-white/10 text-white/85"
        :title="playing ? 'Pause' : 'Play'" data-testid="dock-play" @click="playing ? emit('pause') : emit('play')">
        <svg v-if="!playing" viewBox="0 0 12 12" class="size-3 fill-current"><path d="M2 1.5v9l8-4.5z"/></svg>
        <svg v-else viewBox="0 0 12 12" class="size-3 fill-current"><path d="M2 1.5h3v9H2zM7 1.5h3v9H7z"/></svg>
      </button>
      <span class="tabular-nums text-white/70">{{ (t ?? 0).toFixed(2) }} / {{ duration.toFixed(1) }}s</span>
      <span v-if="view.zoom > 1" class="tabular-nums text-white/30">{{ view.zoom.toFixed(1) }}×</span>
      <div class="flex-1" />
      <button type="button" data-testid="add-behaviour-toggle"
        class="flex items-center gap-1 h-7 px-2.5 rounded-md text-[11px] font-medium cursor-pointer transition-colors"
        :class="galleryOpen ? 'bg-[#7c9cff] text-black' : 'bg-white/10 text-white/85 hover:bg-white/15'"
        @click="emit('toggle-gallery')">
        <span>{{ galleryOpen ? '−' : '+' }}</span><span>Add behaviour</span>
      </button>
      <button type="button" data-testid="add-property-toggle"
        class="flex items-center gap-1 h-7 px-2.5 rounded-md text-[11px] font-medium cursor-pointer transition-colors"
        :class="propertyPickerOpen ? 'bg-[#7c9cff] text-black' : 'bg-white/10 text-white/85 hover:bg-white/15'"
        title="Animate any property directly (transform, fill, effect dials)"
        @click="emit('toggle-property-picker')">
        <span>{{ propertyPickerOpen ? '−' : '+' }}</span><span>Add property</span>
      </button>
      <label class="flex items-center gap-1 text-white/45">dur
        <input v-scrubnum type="number" min="0.5" max="60" step="0.5" :value="duration"
          class="w-12 bg-[#0d0d0d] border border-white/10 rounded px-1 py-0.5 text-white/90 outline-none tabular-nums"
          @change="emit('update:motion', { duration: Math.max(0.5, Number(($event.target as HTMLInputElement).value) || 4) })"></label>
      <label class="flex items-center gap-1 text-white/45">fps
        <input v-scrubnum type="number" min="1" max="60" step="1" :value="fps ?? 30"
          class="w-11 bg-[#0d0d0d] border border-white/10 rounded px-1 py-0.5 text-white/90 outline-none tabular-nums"
          @change="emit('update:motion', { fps: Math.max(1, Math.min(60, Number(($event.target as HTMLInputElement).value) || 30)) })"></label>
      <label class="flex items-center gap-1 text-white/45 cursor-pointer" title="Loop playback">
        <input type="checkbox" class="accent-[#7c9cff]" :checked="loop ?? false"
          @change="emit('update:motion', { loop: ($event.target as HTMLInputElement).checked })">loop</label>
      <span v-if="bakeError" class="max-w-[160px] truncate text-rose-400" :title="bakeError">{{ bakeError }}</span>
      <button type="button" class="h-7 px-2.5 rounded-md text-[11px] font-medium cursor-pointer transition-colors"
        :class="stale ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30' : 'bg-white/10 text-white/80 hover:bg-white/15'"
        :disabled="baking" :title="stale ? 'Layers changed since last bake' : 'Bake motion to frames'"
        data-testid="dock-bake" @click="emit('bake')">
        {{ baking ? `Baking ${Math.round((bakeProgress ?? 0) * 100)}%` : stale ? 'Re-bake' : 'Bake' }}
      </button>
    </div>
    <!-- Add behaviour / Add property open as a POPOVER anchored to the header (upward, the
         dock sits at the bottom of the frame) — never expanding the dock itself. -->
    <div v-if="galleryOpen || propertyPickerOpen" ref="popoverEl" data-testid="dock-popover"
      class="absolute right-2.5 bottom-[calc(100%-2px)] z-50 w-[min(560px,calc(100vw-48px))] max-h-[min(62vh,640px)] overflow-y-auto rounded-[14px] border border-white/10 bg-[#0e0e10]/95 backdrop-blur-md shadow-[0_8px_32px_rgba(0,0,0,.5)]"
      @pointerdown.stop @wheel.stop>
      <slot v-if="galleryOpen" name="gallery" />
      <slot v-else name="property-picker" />
    </div>

    <div class="grid grid-cols-[96px_1fr] gap-x-2">
      <!-- Ruler row (28px) -->
      <div class="h-7" />
      <div ref="laneEl" class="relative h-7 select-none cursor-ew-resize overflow-hidden tabular-nums"
        data-testid="timeline-ruler" @pointerdown.stop.prevent="onRulerDown">
        <div v-for="tk in ticks.fine" :key="'f' + tk" class="absolute bottom-0 w-px h-2 bg-white/10" :style="{ left: px(xOf(tk)) }" />
        <div v-for="tk in ticks.medium" :key="'m' + tk" class="absolute bottom-0 w-px h-3.5 bg-white/15" :style="{ left: px(xOf(tk)) }" />
        <template v-for="tk in ticks.major" :key="'M' + tk">
          <div class="absolute bottom-0 top-0 w-px bg-white/20" :style="{ left: px(xOf(tk)) }" />
          <span class="absolute top-0 -translate-x-1/2 text-[9.5px] text-white/40 whitespace-nowrap" :style="{ left: px(xOf(tk)) }">{{ formatRulerSeconds(tk, ticks.majorStep) }}</span>
        </template>
        <div v-if="playheadVisible" class="absolute inset-y-0 w-px bg-[#7c9cff] z-30 pointer-events-none" :style="{ left: px(playheadX) }" />
        <!-- playhead time flag (Sailor accent), centre clamped inside the lane like DialKit -->
        <div v-if="playheadVisible" data-testid="playhead-flag"
          class="absolute top-0 -translate-x-1/2 h-4 px-1.5 rounded-[5px] bg-[#7c9cff] text-black text-[9.5px] leading-4 tabular-nums font-medium z-40 pointer-events-none"
          :style="{ left: px(flagX) }">{{ (t ?? 0).toFixed(2) }}</div>
      </div>

      <!-- Each layer is a collapsible group header; its behaviours + property bands are
           rows (one compact bar each) — DialKit's clip-per-row model. -->
      <template v-for="l in layers" :key="l.id">
        <button class="col-span-2 flex items-center gap-1.5 h-[22px] text-[11px] cursor-pointer"
          :class="l.id === selectedId ? 'text-white' : 'text-white/55 hover:text-white/80'"
          @click="emit('select', l.id)">
          <span class="inline-block w-3 text-center transition-transform text-white/40 hover:text-white/70"
            :class="collapsedLayers.has(l.id) ? '-rotate-90' : ''"
            @click.stop="toggleLayer(l.id)">▾</span>
          <span class="truncate">{{ rowLabel(l) }}</span>
        </button>

        <template v-if="!collapsedLayers.has(l.id)">
          <!-- one row per PROPERTY; every bar that drives it lives in this row -->
          <template v-for="r in rowsFor(l)" :key="r.path">
            <span class="truncate text-left text-[10px] pl-5 self-center"
              :class="r.conflicts.size ? 'text-amber-300/80' : 'text-white/45'"
              :title="r.conflicts.size ? r.label + ' — overlapping bars clash; the most recently started one is in charge' : r.label">{{ r.label }}<span v-if="r.conflicts.size" class="ml-1">⚠</span></span>
            <div data-band-lane class="relative my-0.5 h-6">
              <div v-if="playheadVisible" class="absolute inset-y-0 w-px bg-[#7c9cff]/50 pointer-events-none z-30" :style="{ left: px(playheadX) }" />

              <!-- loop ghosts: faint repeats of every looping bar (behaviour or property) -->
              <template v-for="b in [...r.behaviours, ...(r.property ? [r.property] : [])]" :key="'g-' + b.key">
                <div v-for="g in ghostsOf(b)" :key="b.key + '-' + g.index" aria-hidden="true" data-testid="loop-ghost"
                  class="absolute top-1 bottom-1 rounded-[5px] opacity-[0.18] pointer-events-none select-none"
                  :style="{ left: px(xOf(g.start) + 1), width: px(Math.max(1, g.duration * dv.pxPerSecond - 2)), background: b.kind === 'behaviour' ? '#78dcaa' : '#7c9cff' }" />
              </template>
              <span v-if="[...r.behaviours, r.property].some((b) => b?.loop)" aria-hidden="true" data-testid="loop-infinity"
                class="absolute right-[7px] top-1/2 z-20 -translate-y-1/2 text-[13px] font-semibold leading-none text-white/40 pointer-events-none select-none"
                title="Repeats to the end of the timeline">∞</span>

              <!-- behaviour bars -->
              <div v-for="b in r.behaviours" :key="b.key" :data-testid="'beh-band-' + b.behaviourId"
                class="absolute inset-y-0 flex items-center gap-1.5 rounded-md border px-2 text-[9.5px] cursor-grab active:cursor-grabbing overflow-hidden select-none"
                :class="[isBehSel(b) ? 'ring-2 ring-[#7c9cff] text-white' : 'text-white/80',
                         r.conflicts.has(b.key) ? 'border-amber-400/70' : (isBehSel(b) ? 'border-emerald-300' : 'border-emerald-400/40 hover:border-emerald-300/70')]"
                :style="{ left: px(xOf(b.start)), width: px(wOf(b.start, b.end)), background: r.conflicts.has(b.key) ? 'rgba(251,191,36,.14)' : 'rgba(120,220,170,.16)' }"
                :title="b.label + (b.loop ? ' · one cycle, repeats through the timeline' : '') + (r.conflicts.has(b.key) ? ' · overlaps another bar on ' + r.label : '') + ' · drag to move, drag edges to ' + (b.loop ? 'change the cycle length' : 'retime')"
                @pointerdown.stop.prevent="(e: PointerEvent) => startBehDrag(e, b, 'move')">
                <span class="truncate">{{ b.label }}</span>
                <button v-if="isBehSel(b) && wOf(b.start, b.end) > 120" type="button"
                  class="shrink-0 px-1.5 rounded border border-white/25 text-[9px] text-white/85 hover:bg-white/15 cursor-pointer"
                  title="Bake into editable control-point bands"
                  @pointerdown.stop @click.stop="emit('behaviour-open', b.behaviourId!)">Open ▾</button>
                <span v-if="wOf(b.start, b.end) > 56" class="ml-auto shrink-0 tabular-nums text-white/50"
                  :class="b.loop && xOf(b.end) > laneWidth - 26 ? 'mr-4' : ''">{{ (b.end - b.start).toFixed(2) }}s</span>
                <div class="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/25"
                  @pointerdown.stop.prevent="(e: PointerEvent) => startBehDrag(e, b, 'start')" />
                <div class="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-white/25"
                  @pointerdown.stop.prevent="(e: PointerEvent) => startBehDrag(e, b, 'end')" />
              </div>

              <!-- explicit property band (control points) -->
              <div v-if="r.property" :data-testid="'band-' + r.property.key"
                class="absolute inset-y-0 rounded-md border overflow-hidden cursor-grab active:cursor-grabbing"
                :class="[isBandSel(r.property) ? 'ring-2 ring-[#7c9cff] border-[#7c9cff]' : (r.conflicts.has(r.property.key) ? 'border-amber-400/70' : 'border-white/15')]"
                :style="{ left: px(xOf(r.property.start)), width: px(wOf(r.property.start, r.property.end)), background: r.property.kind === 'number' ? 'linear-gradient(180deg,#171a20,#12141a)' : bandCss(r.property) }"
                @pointerdown.stop.prevent="(e: PointerEvent) => startShift(e, r.property!)">
                <svg v-if="r.property.kind === 'number'" viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-full block pointer-events-none">
                  <polyline :points="curvePoints(r.property)" fill="none" stroke="#7c9cff" stroke-width="2" vector-effect="non-scaling-stroke" />
                </svg>
                <div class="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize z-20 hover:bg-white/20"
                  @pointerdown.stop.prevent="(e: PointerEvent) => startRetime(e, r.property!, 'start')" />
                <div class="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize z-20 hover:bg-white/20"
                  @pointerdown.stop.prevent="(e: PointerEvent) => startRetime(e, r.property!, 'end')" />
                <div v-for="(kf, i) in r.property.keyframes" :key="i"
                  :data-testid="'point-' + r.property.key + '-' + i"
                  class="absolute top-1/2 w-2.5 h-2.5 -ml-[5px] -mt-[5px] rounded-full bg-white cursor-ew-resize z-20"
                  :class="isPointSel(r.property, i) ? 'ring-2 ring-[#7c9cff] border border-white' : 'border border-[#7c9cff] hover:ring-1 hover:ring-white/60'"
                  :style="{ left: pctX(pointX(r.property, kf.t)) }"
                  title="Drag to move · click to edit · double-click to delete"
                  @pointerdown.stop.prevent="(e: PointerEvent) => startPointDrag(e, r.property!, i)"
                  @click.stop="emit('select-point', { path: r.property!.path, index: i })"
                  @dblclick.stop="() => deletePoint(r.property!, i)" />
              </div>
            </div>
          </template>

          <!-- empty layer -->
          <template v-if="rowCountFor(l) === 0">
            <div /><div class="py-1 pl-5 text-[10px] text-white/25">No motion — add a behaviour above.</div>
          </template>
        </template>
      </template>

      <!-- Sticky pan scrollbar (only when zoomed) -->
      <template v-if="view.zoom > 1">
        <div class="h-2.5" />
        <div ref="scrollEl" class="h-2.5 overflow-x-auto overflow-y-hidden" data-testid="timeline-scrollbar" @scroll="onScroll">
          <div :style="{ width: px(laneWidth * view.zoom), height: '1px' }" />
        </div>
      </template>
    </div>

    <!-- Minimal control-point popover -->
    <div v-if="selPointKf" data-testid="point-popover"
      class="mt-2 flex items-center gap-2 rounded-md border border-white/15 bg-[#111]/90 px-2 py-1.5 text-[11px]">
      <span class="text-white/40">{{ selPointBand?.label }} · {{ (selPointKf.t).toFixed(2) }}s</span>
      <template v-if="typeof selPointKf.value === 'number'">
        <input v-scrubnum type="number" step="0.01" :value="selPointKf.value" data-testid="point-number"
          class="w-20 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none tabular-nums"
          @change="setSelPointValue(Number(($event.target as HTMLInputElement).value) || 0)">
      </template>
      <template v-else-if="typeof selPointKf.value === 'string'">
        <input type="color" :value="selPointKf.value" data-testid="point-color"
          class="w-6 h-6 rounded cursor-pointer bg-transparent border border-white/15"
          @input="setSelPointValue(($event.target as HTMLInputElement).value)">
        <span class="tabular-nums text-white/60 uppercase">{{ selPointKf.value }}</span>
      </template>
      <template v-else>
        <span class="text-white/40">Edit gradient in the inspector →</span>
      </template>
    </div>
  </div>
</template>
