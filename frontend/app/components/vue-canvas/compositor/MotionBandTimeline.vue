<script setup lang="ts">
/** "Everything is a band" motion timeline (Slice 2 — interactive). Renders the selected
 *  layer's motionx property bands: number → value curve, colour → transition, gradient →
 *  representative fill; control points sit on the band. Interactions: click a band to select
 *  it; drag the body to shift; drag the end handles to retime; drag a control point to move
 *  it; double-click a point to delete; click a point to select it (opens a minimal popover
 *  + the right-column inspector). Every edit emits the next motionx Track[] upstream. */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { Track } from '~/lib/motionx'
import { bandsForLayer, numberBandCurve, colorBandCss, gradientBandCss, type Band } from '~/lib/motionx/bands'
import { animatableProperties } from '~/lib/motionx/adapter/frame'
import { shiftTrack, retimeTrack, movePoint, removePoint, setPointValue, setBandTrack } from '~/lib/motionx/bandEdit'

export interface MotionSelection { kind: 'band' | 'point'; path: string; index?: number }

const props = defineProps<{
  layers: LocalLayer[]
  selectedId: string | null
  motionx: Track[]
  duration: number
  t: number | null
  selection: MotionSelection | null
}>()
const emit = defineEmits<{
  select: [id: string]
  'select-band': [path: string]
  'select-point': [sel: { path: string; index: number }]
  'update:motionx': [tracks: Track[]]
  'before-change': []
  commit: []
}>()

const pct = (f: number) => `${(Math.max(0, Math.min(1, f)) * 100).toFixed(3)}%`
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

const trackByPath = (path: string) => props.motionx.find((t) => t.path === path)
const bandLeft = (b: Band) => (props.duration > 0 ? b.start / props.duration : 0)
const bandWidth = (b: Band) =>
  props.duration > 0 ? Math.max(0.012, (b.end - b.start) / props.duration) : 0.012
const pointX = (b: Band, t: number) => {
  const s = b.end - b.start
  return s < 1e-9 ? 0 : (t - b.start) / s
}
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
const isBandSel = (b: Band) => props.selection?.path === b.path
const isPointSel = (b: Band, i: number) =>
  props.selection?.kind === 'point' && props.selection.path === b.path && props.selection.index === i

// ── Drag plumbing (mirrors CompositorMotionTimeline idiom) ───────────────────
let activeCleanup: (() => void) | null = null
onScopeDispose(() => activeCleanup?.())
// Map a clientX within the lane element to seconds across the full duration.
function laneSeconds(laneEl: HTMLElement, clientX: number): number {
  const r = laneEl.getBoundingClientRect()
  return Math.max(0, Math.min(props.duration, ((clientX - r.left) / r.width) * props.duration))
}
function emitTrack(next: Track): void {
  emit('update:motionx', setBandTrack(props.motionx, next.path, next))
}

// Drag the band body → shift all keyframes by the pointer delta (in seconds).
function startShift(e: PointerEvent, b: Band) {
  const tk = trackByPath(b.path)
  if (!tk) return
  emit('select-band', b.path)
  emit('before-change')
  const lane = (e.currentTarget as HTMLElement).closest('[data-band-lane]') as HTMLElement
  const r = lane.getBoundingClientRect()
  const startX = e.clientX
  const move = (ev: PointerEvent) => {
    const deltaT = ((ev.clientX - startX) / r.width) * props.duration
    emitTrack(shiftTrack(tk, deltaT))
  }
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); activeCleanup = null; emit('commit') }
  activeCleanup = up
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
}
// Drag an end handle → retime (rescale) the band to the dragged start/end.
function startRetime(e: PointerEvent, b: Band, edge: 'start' | 'end') {
  const tk = trackByPath(b.path)
  if (!tk) return
  emit('select-band', b.path)
  emit('before-change')
  const lane = (e.currentTarget as HTMLElement).closest('[data-band-lane]') as HTMLElement
  const move = (ev: PointerEvent) => {
    const s = laneSeconds(lane, ev.clientX)
    const cur = bands.value.find((x) => x.path === b.path)!
    const next = edge === 'start' ? retimeTrack(tk, Math.min(s, cur.end - 0.05), cur.end)
      : retimeTrack(tk, cur.start, Math.max(s, cur.start + 0.05))
    emitTrack(next)
  }
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); activeCleanup = null; emit('commit') }
  activeCleanup = up
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
}
// Drag a control point horizontally → move its time; selection follows the new index.
function startPointDrag(e: PointerEvent, b: Band, i: number) {
  const tk = trackByPath(b.path)
  if (!tk) return
  emit('select-point', { path: b.path, index: i })
  emit('before-change')
  const lane = (e.currentTarget as HTMLElement).closest('[data-band-lane]') as HTMLElement
  let idx = i
  const move = (ev: PointerEvent) => {
    const s = laneSeconds(lane, ev.clientX)
    const res = movePoint(trackByPath(b.path) ?? tk, idx, s)
    idx = res.index
    emit('update:motionx', setBandTrack(props.motionx, b.path, res.track))
    emit('select-point', { path: b.path, index: idx })
  }
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); activeCleanup = null; emit('commit') }
  activeCleanup = up
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
}
function deletePoint(b: Band, i: number) {
  const tk = trackByPath(b.path)
  if (!tk) return
  emit('before-change')
  const next = removePoint(tk, i)
  emit('update:motionx', setBandTrack(props.motionx, b.path, next.keyframes.length ? next : null))
  emit('commit')
}

// ── Minimal control-point popover (number / colour quick input) ──────────────
const selPointBand = computed<Band | null>(() =>
  props.selection?.kind === 'point' ? (bands.value.find((b) => b.path === props.selection!.path) ?? null) : null)
const selPointKf = computed(() => {
  const b = selPointBand.value
  const i = props.selection?.index
  return b && i != null ? b.keyframes[i] ?? null : null
})
function setSelPointNumber(v: number) {
  const b = selPointBand.value, i = props.selection?.index, tk = b && trackByPath(b.path)
  if (!b || i == null || !tk) return
  emit('before-change')
  emit('update:motionx', setBandTrack(props.motionx, b.path, setPointValue(tk, i, v)))
  emit('commit')
}
function setSelPointColor(v: string) {
  const b = selPointBand.value, i = props.selection?.index, tk = b && trackByPath(b.path)
  if (!b || i == null || !tk) return
  emit('before-change')
  emit('update:motionx', setBandTrack(props.motionx, b.path, setPointValue(tk, i, v)))
  emit('commit')
}
</script>

<template>
  <div class="rounded-[12px] border border-[#2a2a2a] bg-[#1a1a1a]/95 p-2.5 text-xs text-white/70" data-testid="band-timeline">
    <div class="mb-2 flex items-center gap-2 text-[11px]">
      <span class="tabular-nums text-white/60">{{ (t ?? 0).toFixed(2) }} / {{ duration.toFixed(1) }}s</span>
      <span class="text-white/30">Band timeline</span>
    </div>
    <div class="grid grid-cols-[110px_1fr] gap-x-2">
      <template v-for="l in layers" :key="l.id">
        <button class="truncate text-left text-[11px] cursor-pointer"
          :class="l.id === selectedId ? 'text-white' : 'text-white/50 hover:text-white/75'"
          @click="emit('select', l.id)">{{ rowLabel(l) }}</button>
        <div class="relative my-0.5 h-5 rounded border border-white/10 bg-white/[0.03]" />
      </template>

      <template v-for="b in bands" :key="b.key">
        <span class="truncate text-left text-[10px] pl-3 self-center cursor-pointer"
          :class="isBandSel(b) ? 'text-white' : 'text-white/40 hover:text-white/70'"
          :title="b.label" @click="emit('select-band', b.path)">{{ b.label }}</span>
        <div data-band-lane class="relative my-0.5 h-7">
          <!-- playhead -->
          <div v-if="t != null" class="absolute inset-y-0 w-px bg-white/50 pointer-events-none z-30"
            :style="{ left: pct(duration > 0 ? (t ?? 0) / duration : 0) }" />
          <!-- band body -->
          <div class="absolute inset-y-0 rounded-md border overflow-hidden cursor-grab active:cursor-grabbing"
            :data-testid="'band-' + b.key"
            :class="isBandSel(b) ? 'border-[#7c9cff] ring-1 ring-[#7c9cff]' : 'border-white/15'"
            :style="{ left: pct(bandLeft(b)), width: pct(bandWidth(b)), background: b.kind === 'number' ? 'linear-gradient(180deg,#171a20,#12141a)' : bandCss(b) }"
            @pointerdown.stop.prevent="(e: PointerEvent) => startShift(e, b)">
            <svg v-if="b.kind === 'number'" viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-full block pointer-events-none">
              <polyline :points="curvePoints(b)" fill="none" stroke="#7c9cff" stroke-width="2" vector-effect="non-scaling-stroke" />
            </svg>
            <!-- end handles -->
            <div class="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize z-20 hover:bg-white/20"
              @pointerdown.stop.prevent="(e: PointerEvent) => startRetime(e, b, 'start')" />
            <div class="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize z-20 hover:bg-white/20"
              @pointerdown.stop.prevent="(e: PointerEvent) => startRetime(e, b, 'end')" />
            <!-- control points -->
            <div v-for="(kf, i) in b.keyframes" :key="i"
              :data-testid="'point-' + b.key + '-' + i"
              class="absolute top-1/2 w-2.5 h-2.5 -ml-[5px] -mt-[5px] rounded-full bg-white cursor-ew-resize z-20"
              :class="isPointSel(b, i) ? 'ring-2 ring-[#7c9cff] border border-white' : 'border border-[#7c9cff] hover:ring-1 hover:ring-white/60'"
              :style="{ left: pct(pointX(b, kf.t)) }"
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
    </div>

    <!-- Minimal control-point popover: just the quick input (number / colour). Rich edits
         (gradient, ease) live in the right-column inspector. -->
    <div v-if="selPointKf" data-testid="point-popover"
      class="mt-2 flex items-center gap-2 rounded-md border border-white/15 bg-[#111]/90 px-2 py-1.5 text-[11px]">
      <span class="text-white/40">{{ selPointBand?.label }} · {{ (selPointKf.t).toFixed(2) }}s</span>
      <template v-if="typeof selPointKf.value === 'number'">
        <input v-scrubnum type="number" step="0.01" :value="selPointKf.value" data-testid="point-number"
          class="w-20 bg-[#0d0d0d] border border-white/15 rounded px-1 py-0.5 text-white/90 outline-none"
          @change="setSelPointNumber(Number(($event.target as HTMLInputElement).value) || 0)">
      </template>
      <template v-else-if="typeof selPointKf.value === 'string'">
        <input type="color" :value="selPointKf.value" data-testid="point-color"
          class="w-6 h-6 rounded cursor-pointer bg-transparent border border-white/15"
          @input="setSelPointColor(($event.target as HTMLInputElement).value)">
        <span class="tabular-nums text-white/60 uppercase">{{ selPointKf.value }}</span>
      </template>
      <template v-else>
        <span class="text-white/40">Edit gradient in the inspector →</span>
      </template>
    </div>
  </div>
</template>
