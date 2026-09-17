<script setup lang="ts">
/** Read-only "everything is a band" motion timeline (Slice 1). Renders the selected
 *  layer's motionx property bands: number → value curve, colour → transition, gradient
 *  → representative fill; control points sit on the band. Authoring (retime, points,
 *  behaviours, gallery) lands in later slices. */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { Track } from '~/lib/motionx'
import { bandsForLayer, numberBandCurve, colorBandCss, gradientBandCss, type Band } from '~/lib/motionx/bands'
import { animatableProperties } from '~/lib/motionx/adapter/frame'

const props = defineProps<{
  layers: LocalLayer[]
  selectedId: string | null
  motionx: Track[]
  duration: number
  t: number | null
}>()
defineEmits<{ select: [id: string] }>()

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

// left/width as fractions of the whole duration
const bandLeft = (b: Band) => (props.duration > 0 ? b.start / props.duration : 0)
const bandWidth = (b: Band) =>
  props.duration > 0 ? Math.max(0.01, (b.end - b.start) / props.duration) : 0.01
// control-point x within the band (0..1 across the band span)
const pointX = (b: Band, t: number) => {
  const span = b.end - b.start
  return span < 1e-9 ? 0 : (t - b.start) / span
}
function curvePoints(b: Band): string {
  const tk = props.motionx.find((t) => t.path === b.path)
  if (!tk) return ''
  return numberBandCurve(tk).map((p) => `${(p.x * 100).toFixed(2)},${((1 - p.y) * 100).toFixed(2)}`).join(' ')
}
function bandCss(b: Band): string {
  const tk = props.motionx.find((t) => t.path === b.path)
  if (!tk) return 'transparent'
  return b.kind === 'color' ? colorBandCss(tk) : b.kind === 'gradient' ? gradientBandCss(tk) : 'transparent'
}
</script>

<template>
  <div class="rounded-[12px] border border-[#2a2a2a] bg-[#1a1a1a]/95 p-2.5 text-xs text-white/70" data-testid="band-timeline">
    <div class="mb-2 flex items-center gap-2 text-[11px]">
      <span class="tabular-nums text-white/60">{{ (t ?? 0).toFixed(2) }} / {{ duration.toFixed(1) }}s</span>
      <span class="text-white/30">Band preview</span>
    </div>
    <div class="grid grid-cols-[110px_1fr] gap-x-2">
      <template v-for="l in layers" :key="l.id">
        <button class="truncate text-left text-[11px] cursor-pointer"
          :class="l.id === selectedId ? 'text-white' : 'text-white/50 hover:text-white/75'"
          @click="$emit('select', l.id)">{{ rowLabel(l) }}</button>
        <div class="relative my-0.5 h-5 rounded border border-white/10 bg-white/[0.03]" />
      </template>
      <template v-for="b in bands" :key="b.key">
        <span class="truncate text-left text-[10px] text-white/40 pl-3 self-center" :title="b.label">{{ b.label }}</span>
        <div class="relative my-0.5 h-7">
          <div class="absolute inset-y-0 rounded-md border border-white/15 overflow-hidden"
            :data-testid="'band-' + b.key"
            :style="{ left: pct(bandLeft(b)), width: pct(bandWidth(b)), background: b.kind === 'number' ? 'linear-gradient(180deg,#171a20,#12141a)' : bandCss(b) }">
            <svg v-if="b.kind === 'number'" viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-full block">
              <polyline :points="curvePoints(b)" fill="none" stroke="#7c9cff" stroke-width="2" vector-effect="non-scaling-stroke" />
            </svg>
            <div v-for="(kf, i) in b.keyframes" :key="i"
              class="absolute top-1/2 w-2 h-2 -ml-1 -mt-1 rounded-full bg-white border border-[#7c9cff]"
              :style="{ left: pct(pointX(b, kf.t)) }" />
          </div>
        </div>
      </template>
      <template v-if="selectedLayer && bands.length === 0">
        <div /><div class="py-2 text-[11px] text-white/30">No motion on this layer yet.</div>
      </template>
    </div>
  </div>
</template>
