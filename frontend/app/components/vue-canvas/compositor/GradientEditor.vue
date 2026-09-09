<script setup lang="ts">
/**
 * GradientEditor — authors a compositor `Gradient` (linear or radial, with any
 * number of stops). Used inside FillControl when the fill type is "gradient".
 * A live bar shows the gradient; stop handles on the bar drag to reposition,
 * and a row per stop edits colour / removes it. Emits the native multi-stop
 * Gradient so it drops straight into resolvePaint (no 2-stop collapse).
 */
import { ref, computed } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import { hueWalk } from '~/lib/color/hueWalk'
import type { Gradient, GradientStop } from '~/composables/useCompositorLayers'

const props = defineProps<{ modelValue: Gradient }>()
const emit = defineEmits<{ 'update:modelValue': [Gradient] }>()

const barRef = ref<HTMLElement | null>(null)

// ── Interpolation ─────────────────────────────────────────────────────────────
// 'direct' is today's behaviour: sRGB between the author stops. The hue modes
// pre-expand each adjacent pair into a walk round the colour wheel (short or long
// way) so the native canvas gradient carries chroma across the middle instead of
// desaturating through it. The chosen mode and the ORIGINAL author stops ride
// along on the emitted gradient as extra fields (`interp` / `interpBase`), so the
// choice round-trips through save/load and Direct can be recovered losslessly.
// Direct emits neither field, so a direct gradient stays byte-identical to today.
type Interp = 'direct' | 'hue-short' | 'hue-long'
type WalkGradient = Gradient & { interp?: Interp; interpBase?: GradientStop[] }
const INTERP_OPTIONS = ['Direct', 'Hue (short)', 'Hue (long)'] as const
const INTERP_BY_LABEL: Record<string, Interp> = {
  'Direct': 'direct', 'Hue (short)': 'hue-short', 'Hue (long)': 'hue-long',
}
const LABEL_BY_INTERP: Record<Interp, string> = {
  direct: 'Direct', 'hue-short': 'Hue (short)', 'hue-long': 'Hue (long)',
}
/** Interior stops walked per adjacent author pair when a hue mode is on. */
const WALK_STOPS = 7

const isRadial = computed(() => props.modelValue.type === 'radial')
const angle = computed(() => (props.modelValue.type === 'linear' ? props.modelValue.angle : 45))

const interp = computed<Interp>(() => {
  const v = (props.modelValue as WalkGradient).interp
  return v === 'hue-short' || v === 'hue-long' ? v : 'direct'
})
/** The author's own stops — the editable source of truth. Under a hue mode the
 *  visible `stops` are baked, so we keep the originals in `interpBase`. */
const authorStops = computed<GradientStop[]>(() => {
  const base = (props.modelValue as WalkGradient).interpBase
  return interp.value !== 'direct' && Array.isArray(base) && base.length >= 2 ? base : props.modelValue.stops
})
/** What actually renders: baked under a hue mode, the author stops under Direct. */
const bakedStops = computed<GradientStop[]>(() => props.modelValue.stops)
// Handles and per-stop rows edit the AUTHOR stops.
const stops = computed(() => authorStops.value)

/** Expand author stops into the rendered stops for the given mode. Direct passes
 *  the author stops straight through (reference-equal → byte-identical emit). */
function bake(author: GradientStop[], mode: Interp): GradientStop[] {
  if (mode === 'direct') return author
  const arc = mode === 'hue-long' ? 'long' : 'short'
  const sorted = [...author].sort((a, b) => a.offset - b.offset)
  const out: GradientStop[] = []
  for (let k = 0; k < sorted.length - 1; k++) {
    const lo = sorted[k]!, hi = sorted[k + 1]!
    hueWalk(lo.color, hi.color, WALK_STOPS, { arc }).forEach((w, wi) => {
      if (k > 0 && wi === 0) return // shared boundary already emitted by the previous pair
      out.push({ offset: lo.offset + (hi.offset - lo.offset) * w.pos, color: w.color })
    })
  }
  return out
}

/** Emit a gradient built from the current value plus a patch. */
function emitWith(patch: { type?: 'linear' | 'radial'; angle?: number; stops?: GradientStop[]; interp?: Interp }): void {
  const type = patch.type ?? props.modelValue.type
  const mode = patch.interp ?? interp.value
  const author = patch.stops ?? authorStops.value
  const baked = bake(author, mode)
  let g: Gradient
  if (type === 'radial') g = { type: 'radial', stops: baked }
  else g = { type: 'linear', angle: patch.angle ?? angle.value, stops: baked }
  if (mode !== 'direct') {
    const ann = g as WalkGradient
    ann.interp = mode
    ann.interpBase = author
  }
  emit('update:modelValue', g)
}

function setMode(m: 'linear' | 'radial') { emitWith({ type: m }) }
function setInterp(mode: Interp) { emitWith({ interp: mode }) }
const interpLabel = computed<string>({
  get: () => LABEL_BY_INTERP[interp.value],
  set: (label: string) => setInterp(INTERP_BY_LABEL[label] ?? 'direct'),
})
function setAngle(a: number) { emitWith({ type: 'linear', angle: a }) }
function setStopColor(i: number, color: string) {
  emitWith({ stops: authorStops.value.map((s, j) => (j === i ? { ...s, color } : s)) })
}
function setStopOffset(i: number, offset: number) {
  const o = Math.max(0, Math.min(1, offset))
  emitWith({ stops: authorStops.value.map((s, j) => (j === i ? { ...s, offset: o } : s)) })
}
function addStop() {
  const src = authorStops.value
  const sorted = [...src].sort((a, b) => a.offset - b.offset)
  // Insert at the midpoint of the widest gap, colour-blended toward its left edge.
  let bestGap = -1, at = 0.5, color = sorted[0]?.color ?? '#ffffff'
  for (let k = 0; k < sorted.length - 1; k++) {
    const lo = sorted[k]!, hi = sorted[k + 1]!
    const g = hi.offset - lo.offset
    if (g > bestGap) { bestGap = g; at = (lo.offset + hi.offset) / 2; color = lo.color }
  }
  emitWith({ stops: [...src, { offset: at, color }] })
}
function removeStop(i: number) {
  if (authorStops.value.length <= 2) return
  emitWith({ stops: authorStops.value.filter((_, j) => j !== i) })
}

const cssGradient = computed(() => {
  const ss = [...bakedStops.value].sort((a, b) => a.offset - b.offset)
    .map(s => `${s.color} ${Math.round(s.offset * 100)}%`).join(', ')
  return isRadial.value ? `radial-gradient(circle at center, ${ss})` : `linear-gradient(90deg, ${ss})`
})

function onHandleDown(i: number, e: PointerEvent) {
  e.preventDefault(); e.stopPropagation()
  const bar = barRef.value; if (!bar) return
  const move = (ev: PointerEvent) => {
    const r = bar.getBoundingClientRect()
    setStopOffset(i, r.width ? (ev.clientX - r.left) / r.width : 0)
  }
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
}
</script>

<template>
  <div class="space-y-2">
    <!-- linear / radial — the shared segmented, not hand-rolled buttons -->
    <StudioSegmented
      :model-value="isRadial ? 'Radial' : 'Linear'" :options="['Linear', 'Radial']"
      @update:model-value="(v: string) => setMode(v === 'Radial' ? 'radial' : 'linear')"
    />

    <!-- Interpolation: sRGB (Direct) vs a hue walk round the wheel. A select, not a
         3-up segmented — "Hue (short)" / "Hue (long)" wrap onto two lines in a panel
         this narrow, and as a labelled row it lines up with Angle and the stops. -->
    <StudioSelect v-model="interpLabel" label="Interpolation" :options="[...INTERP_OPTIONS]" />

    <!-- preview bar + draggable stop handles -->
    <div ref="barRef" class="relative h-6 rounded border border-white/10 overflow-visible"
      :style="{ background: cssGradient }">
      <div v-for="(s, i) in stops" :key="'h' + i"
        class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-3 rounded-full border-2 border-white shadow cursor-ew-resize"
        :style="{ left: (s.offset * 100) + '%', background: s.color }"
        @pointerdown="onHandleDown(i, $event)" />
    </div>

    <!-- angle (linear only) -->
    <StudioSlider v-if="!isRadial" :model-value="angle" @update:model-value="(v) => setAngle(v)"
      label="Angle" :min="0" :max="360" :step="5" :bindable="false" />

    <!-- per-stop rows -->
    <div class="space-y-1.5">
      <!-- One studio row per stop — colour, position, remove — matching Angle above
           (and the ink rows in ShaderFillEditor) instead of a bare number + "%". -->
      <div v-for="(s, i) in stops" :key="'r' + i" class="flex items-center gap-2">
        <StudioColor :model-value="s.color" @update:model-value="(v: string) => setStopColor(i, v)" />
        <div class="min-w-0 flex-1">
          <StudioSlider :model-value="Math.round(s.offset * 100)" @update:model-value="(v: number) => setStopOffset(i, v / 100)"
            :min="0" :max="100" :step="1" :bindable="false" />
        </div>
        <button type="button" class="shrink-0 rounded p-0.5 text-white/30 hover:bg-white/10 hover:text-white/70 disabled:opacity-20 disabled:hover:bg-transparent cursor-pointer"
          :disabled="stops.length <= 2" title="Remove stop" @click="removeStop(i)"><Trash2 :size="12" /></button>
      </div>
    </div>

    <button type="button" class="w-full h-6 rounded border border-dashed border-white/15 text-[11px] text-white/55 hover:text-white/85 hover:border-white/30 cursor-pointer"
      @click="addStop">+ Add stop</button>
  </div>
</template>
