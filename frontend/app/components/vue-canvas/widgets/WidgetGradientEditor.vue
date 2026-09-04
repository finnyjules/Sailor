<script setup lang="ts">
// Node widget for the Duotone + Gradient Map nodes. Owns a JSON blob:
//   duotone mode → {"shadow":"#..","highlight":"#.."}
//   stops mode   → [{"pos":0..1,"color":"#.."}, …]
// Renders an editable stop strip (or shadow/highlight pair) plus the shared
// color-theory PalettePicker for bulk fills.
import { ref, computed, watch } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
import PalettePicker from '~/components/vue-canvas/studio/PalettePicker.vue'
import type { GradientStop } from '~/lib/color/harmony'

const props = defineProps<{ modelValue: string; label?: string; mode?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const isStops = computed(() => (props.mode ?? 'stops') === 'stops')
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const defaultStops = (): GradientStop[] => [
  { pos: 0, color: '#06283d' }, { pos: 0.5, color: '#256d85' }, { pos: 1, color: '#47b5ff' },
]

const shadow = ref('#1a1a2e')
const highlight = ref('#f5f5f5')
const stops = ref<GradientStop[]>(defaultStops())
const showPicker = ref(false)

function hydrate(raw: string) {
  try {
    const v = JSON.parse(raw || (isStops.value ? '[]' : '{}'))
    if (isStops.value) {
      stops.value = Array.isArray(v) && v.length
        ? v.map((x: any) => ({ pos: clamp01(Number(x.pos) || 0), color: String(x.color ?? '#000000') }))
        : defaultStops()
    } else {
      shadow.value = String(v?.shadow ?? '#1a1a2e')
      highlight.value = String(v?.highlight ?? '#f5f5f5')
    }
  } catch { if (isStops.value) stops.value = defaultStops() }
}
hydrate(props.modelValue)
watch(() => props.modelValue, hydrate)

const sorted = () => [...stops.value].sort((a, b) => a.pos - b.pos)
function push() {
  emit('update:modelValue', isStops.value
    ? JSON.stringify(sorted())
    : JSON.stringify({ shadow: shadow.value, highlight: highlight.value }))
}

function setStopColor(i: number, c: string) { stops.value[i]!.color = c; push() }
function setStopPos(i: number, p: number) { stops.value[i]!.pos = clamp01(p); push() }
function addStop() {
  const s = sorted()
  // insert at the widest gap
  let gap = -1, at = 0.5
  for (let k = 0; k < s.length - 1; k++) { const g = s[k + 1]!.pos - s[k]!.pos; if (g > gap) { gap = g; at = (s[k]!.pos + s[k + 1]!.pos) / 2 } }
  stops.value.push({ pos: at, color: '#888888' }); push()
}
function removeStop(i: number) { if (stops.value.length > 2) { stops.value.splice(i, 1); push() } }

const rampCss = computed(() => {
  if (isStops.value) {
    const s = sorted()
    return `linear-gradient(to right, ${s.map(x => `${x.color} ${Math.round(x.pos * 100)}%`).join(', ')})`
  }
  return `linear-gradient(to right, ${shadow.value}, ${highlight.value})`
})

function applyDuotone(v: { shadow: string; highlight: string }) { shadow.value = v.shadow; highlight.value = v.highlight; push() }
function applyStops(v: GradientStop[]) { stops.value = v.map(s => ({ pos: s.pos, color: s.color })); push() }
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div v-if="label" class="text-[10px] uppercase tracking-wide text-white/35">{{ label }}</div>

    <!-- ramp / pair preview -->
    <div class="h-6 overflow-hidden rounded border border-white/10" :style="{ background: rampCss }" />

    <!-- editors -->
    <div v-if="!isStops" class="flex items-center gap-3">
      <div class="flex items-center gap-1.5">
        <span class="text-[11px] text-white/55">Shadow</span>
        <StudioColor v-model="shadow" @update:model-value="push" />
      </div>
      <div class="flex items-center gap-1.5">
        <span class="text-[11px] text-white/55">Highlight</span>
        <StudioColor v-model="highlight" @update:model-value="push" />
      </div>
    </div>

    <div v-else class="flex flex-col gap-1">
      <div v-for="(s, i) in stops" :key="i" class="flex items-center gap-2">
        <StudioColor :model-value="s.color" @update:model-value="(c: string) => setStopColor(i, c)" />
        <input
          type="range" min="0" max="1" step="0.01" :value="s.pos"
          class="studio-range h-1 flex-1" @input="(e: any) => setStopPos(i, Number(e.target.value))"
        />
        <span class="w-7 text-right font-mono text-[10px] tabular-nums text-white/40">{{ Math.round(s.pos * 100) }}</span>
        <button class="rounded p-0.5 text-white/30 hover:bg-white/10 hover:text-white/70 disabled:opacity-20" :disabled="stops.length <= 2" @click="removeStop(i)"><Trash2 :size="12" /></button>
      </div>
      <button class="mt-0.5 flex items-center justify-center gap-1 rounded border border-dashed border-white/15 py-1 text-[11px] text-white/50 hover:border-white/30 hover:text-white/80" @click="addStop"><Plus :size="12" /> Add stop</button>
    </div>

    <!-- palette picker (color theory), collapsible -->
    <button class="mt-0.5 text-left text-[11px] text-white/45 hover:text-white/75" @click="showPicker = !showPicker">
      <span class="mr-1 inline-block transition-transform" :class="showPicker ? 'rotate-90' : ''">›</span>Colour-theory palettes
    </button>
    <div v-if="showPicker" class="rounded border border-white/10 bg-white/[0.02] p-2">
      <PalettePicker
        :mode="isStops ? 'stops' : 'duotone'"
        :stop-count="stops.length"
        :seed="isStops ? (stops[0]?.color ?? '#4f8ad9') : highlight"
        @apply-duotone="applyDuotone" @apply-stops="applyStops" @apply-literal-stops="applyStops"
      />
    </div>
  </div>
</template>
