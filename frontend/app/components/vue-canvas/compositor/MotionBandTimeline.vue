<script setup lang="ts">
/** DialKit-style "everything is a band" motion timeline (Slice 6d). Emulates DialKit's
 *  timeline geometry + gestures (ruler with ticks, drag-seek playhead, alt-drag pivot zoom,
 *  shift-reset, wheel/scrollbar pan, DialKit row/clip dimensions, collapsible groups) —
 *  rendered in Sailor tokens (PP Neue Montreal + tabular-nums, compositor palette, #7c9cff
 *  accent, emerald behaviour bands, value-showing clip interiors). View math is the pure
 *  ~/lib/motionx/timelineView (ported from dialkit). motionx stays the source of truth. */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { Track, StoredBehaviour } from '~/lib/motionx'
import { bandsForLayer, behaviourBandsForLayer, numberBandCurve, colorBandCss, gradientBandCss, type Band } from '~/lib/motionx/bands'
import { animatableProperties } from '~/lib/motionx/adapter/frame'
import { shiftTrack, retimeTrack, movePoint, removePoint, setPointValue, setBandTrack } from '~/lib/motionx/bandEdit'
import { deriveView, timeToX, xToTime, zoomAboutPivot, clampViewStart, computeTicks, formatRulerSeconds, type View } from '~/lib/motionx/timelineView'

export interface MotionSelection { kind: 'band' | 'point' | 'behaviour'; path: string; index?: number }

const props = defineProps<{
  layers: LocalLayer[]
  selectedId: string | null
  motionx: Track[]
  behaviours?: StoredBehaviour[]
  duration: number
  t: number | null
  selection: MotionSelection | null
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
}>()

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

const rowLabel = (l: LocalLayer) =>
  (l as { name?: string }).name || (l.kind === 'text' ? ((l as { text?: string }).text?.split('\n')[0] || 'Text') : l.kind)

const selectedLayer = computed(() => props.layers.find((l) => l.id === props.selectedId) ?? null)
const labelMap = computed(() => {
  const m = new Map<string, string>()
  const l = selectedLayer.value
  if (l) for (const p of animatableProperties(l)) m.set(p.path, p.label)
  return m
})
const bands = computed(() =>
  selectedLayer.value
    ? bandsForLayer(selectedLayer.value.id, props.motionx, (p) => labelMap.value.get(p) ?? '')
    : [])

// ── Groups (collapsible layer rows) ──────────────────────────────────────────
const collapsedGroups = ref<Set<string>>(new Set())
function toggleGroup(id: string) {
  const s = new Set(collapsedGroups.value)
  s.has(id) ? s.delete(id) : s.add(id)
  collapsedGroups.value = s
}
type LayerRow = { type: 'group'; id: string } | { type: 'layer'; layer: LocalLayer; grouped: boolean }
const layerRows = computed<LayerRow[]>(() => {
  const out: LayerRow[] = []
  let last: string | undefined
  for (const l of props.layers) {
    const gid = (l as { groupId?: string }).groupId
    if (gid && gid !== last) out.push({ type: 'group', id: gid })
    last = gid
    if (!gid || !collapsedGroups.value.has(gid)) out.push({ type: 'layer', layer: l, grouped: !!gid })
  }
  return out
})

const behBandsFor = (layerId: string) => behaviourBandsForLayer(layerId, props.behaviours ?? [])
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
    const cur = bands.value.find((x) => x.path === b.path)!
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
const selPointBand = computed<Band | null>(() =>
  props.selection?.kind === 'point' ? (bands.value.find((b) => b.path === props.selection!.path) ?? null) : null)
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
  <div class="rounded-[14px] border border-white/10 bg-[#1a1a1a]/95 p-2.5 text-xs text-white/70 font-[var(--font-sans)]" data-testid="band-timeline" @wheel="onWheel">
    <div class="mb-2 flex items-center gap-2 text-[11px]">
      <span class="tabular-nums text-white/60">{{ (t ?? 0).toFixed(2) }} / {{ duration.toFixed(1) }}s</span>
      <span class="text-white/30">Timeline</span>
      <span v-if="view.zoom > 1" class="ml-auto tabular-nums text-white/30">{{ view.zoom.toFixed(1) }}×</span>
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
      </div>

      <!-- Layer rows (behaviour bands live on the layer's lane) -->
      <template v-for="row in layerRows" :key="row.type === 'group' ? 'g:' + row.id : row.layer.id">
        <template v-if="row.type === 'group'">
          <button class="col-span-2 flex items-center gap-1 h-[22px] text-[10px] text-white/45 hover:text-white/75 cursor-pointer"
            @click="toggleGroup(row.id)">
            <span class="inline-block transition-transform" :class="collapsedGroups.has(row.id) ? '-rotate-90' : ''">▾</span>
            <span class="truncate">{{ row.id }}</span>
          </button>
        </template>
        <template v-else>
          <button class="truncate text-left text-[11px] cursor-pointer self-center"
            :class="[row.layer.id === selectedId ? 'text-white' : 'text-white/50 hover:text-white/75', row.grouped ? 'pl-3.5' : '']"
            @click="emit('select', row.layer.id)">{{ rowLabel(row.layer) }}</button>
          <div class="relative my-0.5 h-7 rounded-lg border border-white/10 bg-white/[0.03] overflow-hidden">
            <div v-if="playheadVisible" class="absolute inset-y-0 w-px bg-[#7c9cff]/60 pointer-events-none z-30" :style="{ left: px(playheadX) }" />
            <div v-for="b in behBandsFor(row.layer.id)" :key="b.key"
              :data-testid="'beh-band-' + b.behaviourId"
              class="absolute top-[3px] bottom-[3px] flex items-center gap-1 rounded-md border px-2 text-[10px] cursor-pointer overflow-hidden"
              :class="isBehSel(b) ? 'border-emerald-300 ring-2 ring-[#7c9cff] text-white' : 'border-emerald-400/40 text-white/80 hover:border-emerald-300/70'"
              :style="{ left: px(xOf(b.start)), width: px(wOf(b.start, b.end)), background: 'rgba(120,220,170,.16)' }"
              :title="b.label" @click.stop="emit('select-behaviour', b.behaviourId!)">
              <span class="truncate">{{ b.label }}</span>
            </div>
          </div>
        </template>
      </template>

      <!-- Selected layer's property bands -->
      <template v-for="b in bands" :key="b.key">
        <span class="truncate text-left text-[10px] pl-3 self-center cursor-pointer"
          :class="isBandSel(b) ? 'text-white' : 'text-white/40 hover:text-white/70'"
          :title="b.label" @click="emit('select-band', b.path)">{{ b.label }}</span>
        <div data-band-lane class="relative my-0.5 h-7 overflow-hidden">
          <div v-if="playheadVisible" class="absolute inset-y-0 w-px bg-[#7c9cff]/60 pointer-events-none z-30" :style="{ left: px(playheadX) }" />
          <div class="absolute top-[3px] bottom-[3px] rounded-md border overflow-hidden cursor-grab active:cursor-grabbing"
            :data-testid="'band-' + b.key"
            :class="isBandSel(b) ? 'border-[#7c9cff] ring-2 ring-[#7c9cff]' : 'border-white/15'"
            :style="{ left: px(xOf(b.start)), width: px(wOf(b.start, b.end)), background: b.kind === 'number' ? 'linear-gradient(180deg,#171a20,#12141a)' : bandCss(b) }"
            @pointerdown.stop.prevent="(e: PointerEvent) => startShift(e, b)">
            <svg v-if="b.kind === 'number'" viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-full block pointer-events-none">
              <polyline :points="curvePoints(b)" fill="none" stroke="#7c9cff" stroke-width="2" vector-effect="non-scaling-stroke" />
            </svg>
            <div class="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize z-20 hover:bg-white/20"
              @pointerdown.stop.prevent="(e: PointerEvent) => startRetime(e, b, 'start')" />
            <div class="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize z-20 hover:bg-white/20"
              @pointerdown.stop.prevent="(e: PointerEvent) => startRetime(e, b, 'end')" />
            <div v-for="(kf, i) in b.keyframes" :key="i"
              :data-testid="'point-' + b.key + '-' + i"
              class="absolute top-1/2 w-2.5 h-2.5 -ml-[5px] -mt-[5px] rounded-full bg-white cursor-ew-resize z-20"
              :class="isPointSel(b, i) ? 'ring-2 ring-[#7c9cff] border border-white' : 'border border-[#7c9cff] hover:ring-1 hover:ring-white/60'"
              :style="{ left: pctX(pointX(b, kf.t)) }"
              title="Drag to move · click to edit · double-click to delete"
              @pointerdown.stop.prevent="(e: PointerEvent) => startPointDrag(e, b, i)"
              @click.stop="emit('select-point', { path: b.path, index: i })"
              @dblclick.stop="() => deletePoint(b, i)" />
          </div>
        </div>
      </template>

      <template v-if="selectedLayer && bands.length === 0">
        <div /><div class="py-2 text-[11px] text-white/30">No motion on this layer yet.</div>
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
