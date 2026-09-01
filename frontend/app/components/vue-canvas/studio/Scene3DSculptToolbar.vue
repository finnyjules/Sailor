<script setup lang="ts">
// Sculpt-mode floating toolbar — a single centered pill in the viewport's
// bottom-center dock, shown while `sculpting`. It replaces the add/create
// toolbar there (the same dock Motion mode's timeline uses) and supersedes the
// retired Scene3DSculptPanel. Same v-model surface + apply/exit/remesh emits,
// so the surface's state and handlers bind unchanged.
import { ref, computed, type Component } from 'vue'
import { Paintbrush, Feather, Wind, Hammer, Hand, Magnet, Spline, Minus, Plus, Loader2, ChevronUp } from 'lucide-vue-next'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import { REMESH_RESOLUTION_MAX } from '~/lib/scene3d/toMesh'
import type { BrushKind } from '~/lib/scene3d/sculpt/brushes'
import type { SymmetryMode } from '~/lib/scene3d/sculpt/symmetry'

const brush = defineModel<BrushKind>('brush', { required: true })
const size = defineModel<number>('size', { required: true })
const strength = defineModel<number>('strength', { required: true })
const symmetry = defineModel<SymmetryMode>('symmetry', { required: true })
const symmetryAxis = defineModel<0 | 1 | 2>('symmetryAxis', { required: true })
const symmetryCount = defineModel<number>('symmetryCount', { required: true })
const remeshResolution = defineModel<number>('remeshResolution', { required: true })

const props = defineProps<{
  committing?: boolean
  remeshVertexCount: number
  remeshKb: string
  remeshBusy?: boolean
  remeshError?: string
}>()

defineEmits<{ apply: []; exit: []; remesh: [] }>()

const BRUSHES: { kind: BrushKind; icon: Component; label: string }[] = [
  { kind: 'draw', icon: Paintbrush, label: 'Draw' },
  { kind: 'smooth', icon: Feather, label: 'Smooth' },
  { kind: 'inflate', icon: Wind, label: 'Inflate' },
  { kind: 'flatten', icon: Hammer, label: 'Flatten' },
  { kind: 'grab', icon: Hand, label: 'Grab' },
  { kind: 'pinch', icon: Magnet, label: 'Pinch' },
  { kind: 'crease', icon: Spline, label: 'Crease' },
]

const SYMMETRY_OPTIONS = ['none', 'mirror', 'radial']
const AXIS_LABELS = ['x', 'y', 'z'] as const
const AXIS_OPTIONS = [...AXIS_LABELS]
const axisLabel = computed<string>({
  get: () => AXIS_LABELS[symmetryAxis.value],
  set: (v) => { symmetryAxis.value = AXIS_LABELS.indexOf(v as typeof AXIS_LABELS[number]) as 0 | 1 | 2 },
})

const MIN_RADIAL_COUNT = 2
const MAX_RADIAL_COUNT = 16
function stepCount(delta: number) {
  symmetryCount.value = Math.min(MAX_RADIAL_COUNT, Math.max(MIN_RADIAL_COUNT, symmetryCount.value + delta))
}

const busy = computed(() => !!props.committing || !!props.remeshBusy)
const symOpen = ref(false)
const remeshOpen = ref(false)
</script>

<template>
  <div class="pointer-events-auto flex items-center gap-1.5 rounded-[12px] border border-white/10 bg-[#1a1a1a]/95 p-1.5 shadow-lg backdrop-blur"
       @pointerdown.stop>
    <!-- Brushes: icon strip (StudioSegmented is string-only, so this is hand-rolled) -->
    <div class="flex items-center gap-0.5">
      <button v-for="b in BRUSHES" :key="b.kind" type="button" :title="b.label + ' — hold Alt to carve inward'"
              class="rounded-[6px] p-1.5"
              :class="brush === b.kind ? 'bg-white text-neutral-900' : 'text-white/70 hover:bg-white/10'"
              @click="brush = b.kind">
        <component :is="b.icon" class="size-4" />
      </button>
    </div>

    <div class="mx-0.5 h-6 w-px bg-white/10" />

    <!-- Size / Strength: house sliders in fixed-width wrappers so they sit inline -->
    <div class="w-28"><StudioSlider v-model="size" label="Size" :min="0.02" :max="1" :step="0.01" /></div>
    <div class="w-28"><StudioSlider v-model="strength" label="Str" :min="0.05" :max="1" :step="0.05" /></div>

    <div class="mx-0.5 h-6 w-px bg-white/10" />

    <!-- Symmetry popover (opens upward — dock is at the viewport's bottom edge) -->
    <div class="relative">
      <button type="button" class="flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-[12px]"
              :class="symmetry !== 'none' ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10'"
              @click="symOpen = !symOpen; remeshOpen = false">
        Symmetry <ChevronUp class="size-3.5" :class="{ 'rotate-180': !symOpen }" />
      </button>
      <div v-if="symOpen" class="absolute bottom-full left-0 mb-2 w-56 space-y-2 rounded-lg border border-white/10 bg-[#1a1a1a] p-3 shadow-xl">
        <StudioSegmented v-model="symmetry" :options="SYMMETRY_OPTIONS" />
        <div v-if="symmetry === 'radial'" class="flex items-center gap-3 pt-1">
          <div class="flex items-center gap-1 text-[11px] text-white/50">
            <span>Count</span>
            <button type="button" class="rounded border border-white/10 p-0.5 hover:bg-white/10 disabled:opacity-30" :disabled="symmetryCount <= MIN_RADIAL_COUNT" @click="stepCount(-1)"><Minus :size="11" /></button>
            <span class="w-5 text-center tabular-nums text-white/80">{{ symmetryCount }}</span>
            <button type="button" class="rounded border border-white/10 p-0.5 hover:bg-white/10 disabled:opacity-30" :disabled="symmetryCount >= MAX_RADIAL_COUNT" @click="stepCount(1)"><Plus :size="11" /></button>
          </div>
          <div class="flex flex-1 items-center gap-1 text-[11px] text-white/50">
            <span>Axis</span><StudioSegmented v-model="axisLabel" :options="AXIS_OPTIONS" />
          </div>
        </div>
      </div>
    </div>

    <!-- Remesh popover -->
    <div class="relative">
      <button type="button" class="flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-[12px] text-white/70 hover:bg-white/10"
              @click="remeshOpen = !remeshOpen; symOpen = false">
        Remesh <ChevronUp class="size-3.5" :class="{ 'rotate-180': !remeshOpen }" />
      </button>
      <div v-if="remeshOpen" class="absolute bottom-full left-0 mb-2 w-64 space-y-2 rounded-lg border border-white/10 bg-[#1a1a1a] p-3 shadow-xl">
        <StudioSlider v-model="remeshResolution" label="Resolution" :min="16" :max="REMESH_RESOLUTION_MAX" :step="1" />
        <p class="text-[11px] text-white/45">{{ remeshVertexCount.toLocaleString('en-US') }} vertices · {{ remeshKb }} KB</p>
        <p class="text-[11px] leading-snug text-white/45">Rebuilds the sculpted surface at a new density and clears this sculpt's undo history.</p>
        <StudioButton :disabled="busy" @click="$emit('remesh')">
          <span class="flex items-center gap-1.5"><Loader2 v-if="remeshBusy" class="h-3.5 w-3.5 animate-spin" />{{ remeshBusy ? 'Remeshing…' : 'Remesh' }}</span>
        </StudioButton>
        <p v-if="remeshError" class="text-[11px] leading-snug text-red-400/90">{{ remeshError }}</p>
      </div>
    </div>

    <div class="mx-0.5 h-6 w-px bg-white/10" />

    <StudioButton variant="secondary" :disabled="busy" @click="$emit('exit')">Exit</StudioButton>
    <StudioButton variant="primary" :disabled="busy" @click="$emit('apply')">Apply</StudioButton>
  </div>
</template>
