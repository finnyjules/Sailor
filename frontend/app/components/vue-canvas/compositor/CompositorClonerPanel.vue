<script setup lang="ts">
import { computed } from 'vue'
import { DEFAULT_CLONER, type Cloner } from '~/composables/useCloner'
// The ONE Vary swatch-list editor, shared with the 3D Studio inspector.
import VaryPalette from '~/components/vue-canvas/VaryPalette.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import type { VaryMode, VarySpread } from '~/lib/vary'

const props = defineProps<{ cloner: Cloner | undefined }>()
const emit = defineEmits<{ update: [value: Cloner] }>()

const c = computed<Cloner>(() => ({ ...DEFAULT_CLONER, ...(props.cloner ?? {}) }))

function up(patch: Partial<Cloner>) {
  emit('update', { ...c.value, ...patch })
}
const num = (e: Event) => Number((e.target as HTMLInputElement).value)

// Readable labels for the stored internal values — a picker must never surface
// `sequence` / `cycle` to the user. Word-for-word what the 3D Studio inspector
// ships for the same three pickers, so the two surfaces read identically.
const VARY_MODE_OPTIONS: { value: VaryMode; label: string }[] = [
  { value: 'sequence', label: 'Sequence' },
  { value: 'random', label: 'Random' },
  { value: 'falloff', label: 'Falloff' },
]
const VARY_SPREAD_OPTIONS: { value: VarySpread; label: string }[] = [
  { value: 'cycle', label: 'Cycle' },
  { value: 'blend', label: 'Blend' },
]
// Total instances for the live count chip (excludes the original? no — includes it).
const total = computed(() => {
  const v = c.value
  if (!v.enabled) return 1
  if (v.mode === 'radial') return Math.max(1, Math.floor(v.count))
  const nx = Math.max(1, Math.floor(v.countX))
  const ny = Math.max(1, Math.floor(v.countY))
  return (v.mirrorX ? 2 * nx - 1 : nx) * (v.mirrorY ? 2 * ny - 1 : ny)
})
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-1.5">
      <div class="text-[10px] uppercase tracking-[0.12em] text-white/40">Cloner</div>
      <div class="flex items-center gap-2">
        <span v-if="c.enabled" class="text-[10px] text-white/35 tabular-nums">{{ total }}×</span>
        <!-- enable switch -->
        <button
          class="relative w-8 h-[18px] rounded-full transition-colors cursor-pointer"
          :class="c.enabled ? 'bg-white/80' : 'bg-white/15'"
          :title="c.enabled ? 'Disable cloner' : 'Enable cloner'"
          @click="up({ enabled: !c.enabled })"
        >
          <span class="absolute top-[2px] size-[14px] rounded-full bg-neutral-900 transition-all"
            :class="c.enabled ? 'left-[16px]' : 'left-[2px]'" />
        </button>
      </div>
    </div>

    <template v-if="c.enabled">
      <!-- Mode -->
      <div class="flex items-center gap-1 p-0.5 rounded-md bg-white/[0.05] mb-3">
        <button
          v-for="m in (['linear','radial'] as const)" :key="m"
          class="flex-1 h-7 rounded text-[11px] capitalize cursor-pointer transition-colors"
          :class="c.mode === m ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'"
          @click="up({ mode: m })"
        >{{ m }}</button>
      </div>

      <!-- Linear / grid -->
      <template v-if="c.mode === 'linear'">
        <div class="grid grid-cols-2 gap-3 mb-3">
          <label class="block">
            <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 block mb-1">Count X</span>
            <input v-scrubnum type="number" min="1" max="64" step="1" :value="c.countX"
              class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @input="up({ countX: Math.max(1, Math.round(num($event))) })" />
          </label>
          <label class="block">
            <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 block mb-1">Count Y</span>
            <input v-scrubnum type="number" min="1" max="64" step="1" :value="c.countY"
              class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @input="up({ countY: Math.max(1, Math.round(num($event))) })" />
          </label>
        </div>
        <StudioSlider :model-value="c.spacingX" @update:model-value="(v) => up({ spacingX: v })"
          label="Spacing X" :min="-1" :max="1" :step="0.01" :bindable="false" />
        <StudioSlider :model-value="c.spacingY" @update:model-value="(v) => up({ spacingY: v })"
          label="Spacing Y" :min="-1" :max="1" :step="0.01" :bindable="false" />
        <!-- Mirror: also clone in the opposite direction (original stays centered) -->
        <div class="mb-1">
          <div class="text-[9px] uppercase tracking-[0.1em] text-white/35 mb-1">Mirror</div>
          <div class="flex items-center gap-1">
            <button
              class="flex-1 h-7 rounded text-[11px] cursor-pointer transition-colors"
              :class="c.mirrorX ? 'bg-white text-neutral-900 font-medium' : 'bg-white/[0.05] text-white/70 hover:bg-white/10'"
              :title="c.mirrorX ? 'Stop mirroring on X' : 'Also clone in the -X direction'"
              @click="up({ mirrorX: !c.mirrorX })"
            >X</button>
            <button
              class="flex-1 h-7 rounded text-[11px] cursor-pointer transition-colors"
              :class="c.mirrorY ? 'bg-white text-neutral-900 font-medium' : 'bg-white/[0.05] text-white/70 hover:bg-white/10'"
              :title="c.mirrorY ? 'Stop mirroring on Y' : 'Also clone in the -Y direction'"
              @click="up({ mirrorY: !c.mirrorY })"
            >Y</button>
          </div>
        </div>
        <!-- Stagger: brick-style offset of alternating rows/cols (fraction of spacing) -->
        <div class="mt-3">
          <div class="text-[9px] uppercase tracking-[0.1em] text-white/35 mb-2">Stagger</div>
          <StudioSlider :model-value="c.staggerX" @update:model-value="(v) => up({ staggerX: v })"
            label="X (rows)" :min="0" :max="1" :step="0.01" :bindable="false" />
          <StudioSlider :model-value="c.staggerY" @update:model-value="(v) => up({ staggerY: v })"
            label="Y (cols)" :min="0" :max="1" :step="0.01" :bindable="false" />
        </div>
      </template>

      <!-- Radial -->
      <template v-else>
        <div class="grid grid-cols-2 gap-3 mb-3">
          <label class="block">
            <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 block mb-1">Count</span>
            <input v-scrubnum type="number" min="1" max="128" step="1" :value="c.count"
              class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @input="up({ count: Math.max(1, Math.round(num($event))) })" />
          </label>
          <label class="block">
            <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 block mb-1">Radius</span>
            <input v-scrubnum type="number" min="0" max="2" step="0.01" :value="c.radius"
              class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @input="up({ radius: Math.max(0, num($event)) })" />
          </label>
        </div>
        <StudioSlider :model-value="c.startAngle" @update:model-value="(v) => up({ startAngle: v })"
          label="Start angle" :min="-180" :max="180" :step="1" :bindable="false" />
        <StudioSlider :model-value="c.sweepAngle" @update:model-value="(v) => up({ sweepAngle: v })"
          label="Sweep" :min="0" :max="360" :step="1" :bindable="false" />
        <label class="flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer select-none mb-1">
          <input type="checkbox" :checked="c.faceCenter" @change="up({ faceCenter: (($event.target as HTMLInputElement).checked) })" />
          Face center
        </label>
      </template>

      <!-- Falloff (shared) -->
      <div class="mt-3 pt-3 border-t border-white/[0.07]">
        <div class="text-[9px] uppercase tracking-[0.1em] text-white/35 mb-2">Falloff</div>
        <StudioSlider :model-value="c.stepRotation" @update:model-value="(v) => up({ stepRotation: v })"
          label="Rotation" :min="-90" :max="90" :step="1" :bindable="false" />
        <StudioSlider :model-value="c.phase ?? 1" @update:model-value="(v) => up({ phase: Math.max(0, Math.min(1, v)) })"
          label="Phase" :min="0" :max="1" :step="0.05" :bindable="false" />
        <!-- Nudge: progressive drift per clone (linear/grid only) -->
        <template v-if="c.mode === 'linear'">
          <StudioSlider :model-value="c.nudgeX" @update:model-value="(v) => up({ nudgeX: v })"
            label="Nudge X" :min="-0.5" :max="0.5" :step="0.01" :bindable="false" />
          <StudioSlider :model-value="c.nudgeY" @update:model-value="(v) => up({ nudgeY: v })"
            label="Nudge Y" :min="-0.5" :max="0.5" :step="0.01" :bindable="false" />
        </template>
        <StudioSlider :model-value="c.stepScale" @update:model-value="(v) => up({ stepScale: v })"
          label="Scale" :min="0.5" :max="1.5" :step="0.01" :bindable="false" />
        <StudioSlider :model-value="c.stepOpacity" @update:model-value="(v) => up({ stepOpacity: v })"
          label="Opacity" :min="0.3" :max="1" :step="0.01" :bindable="false" />
      </div>

      <!-- Vary — how a property changes from one copy to the next. Same three
           pickers, same words, as the 3D Studio inspector's Cloner card.
           Gated on MORE THAN ONE COPY, matching that card's `varyOn` predicate
           (lib/scene3d/controls.ts): there is nothing to vary across a single copy,
           and with colour on a lone copy would simply be repainted the first swatch —
           a different meaning of "Vary" than the one the 3D Studio teaches. `total`
           is the same count the header chip shows, so the block appears exactly when
           that chip reads 2x or more.
           MATCHED IN THE RENDERER: `expandClones` (composables/useCloner.ts) and its
           Python mirror `_expand_clones` both skip vary once the expansion comes out
           at a single copy, the way 3D's `count > 1` does — so taking a layer from
           three copies down to one drops the tint instead of stranding it behind this
           hidden block. -->
      <div v-if="total > 1" data-test="vary-block" class="mt-3 pt-3 border-t border-white/[0.07]">
        <div class="text-[9px] uppercase tracking-[0.1em] text-white/35 mb-2">Vary</div>

        <div class="text-[9px] uppercase tracking-[0.1em] text-white/35 mb-1">Pattern</div>
        <div data-test="vary-mode" class="flex items-center gap-1 p-0.5 rounded-md bg-white/[0.05] mb-3">
          <button
            v-for="o in VARY_MODE_OPTIONS" :key="o.value"
            class="flex-1 h-7 rounded text-[11px] cursor-pointer transition-colors"
            :class="c.varyMode === o.value ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'"
            :title="o.label"
            @click="up({ varyMode: o.value })"
          >{{ o.label }}</button>
        </div>

        <label v-if="c.varyMode === 'random'" data-test="vary-seed" class="block mb-3">
          <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 block mb-1">Vary seed</span>
          <input v-scrubnum type="number" min="0" max="99" step="1" :value="c.varySeed"
            class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
            @input="up({ varySeed: Math.max(0, Math.min(99, Math.round(num($event)))) })" />
        </label>

        <div v-if="c.varyMode === 'falloff'" class="grid grid-cols-2 gap-3 mb-3">
          <label data-test="vary-center" class="block">
            <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 block mb-1">Centre</span>
            <input v-scrubnum type="number" min="0" max="1" step="0.01" :value="c.varyFalloffCenter"
              class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @input="up({ varyFalloffCenter: Math.max(0, Math.min(1, num($event))) })" />
          </label>
          <label data-test="vary-reach" class="block">
            <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 block mb-1">Reach</span>
            <input v-scrubnum type="number" min="0.01" max="1" step="0.01" :value="c.varyFalloffRadius"
              class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @input="up({ varyFalloffRadius: Math.max(0.01, Math.min(1, num($event))) })" />
          </label>
        </div>

        <div class="flex items-center justify-between mb-2">
          <span class="text-[11px] text-white/70">Vary colour</span>
          <button
            data-test="vary-color"
            class="relative w-8 h-[18px] rounded-full transition-colors cursor-pointer"
            :class="c.varyColor ? 'bg-white/80' : 'bg-white/15'"
            :title="c.varyColor ? 'Turn off colour variation' : 'Give each copy its own colour'"
            @click="up({ varyColor: !c.varyColor })"
          >
            <span class="absolute top-[2px] size-[14px] rounded-full bg-neutral-900 transition-all"
              :class="c.varyColor ? 'left-[16px]' : 'left-[2px]'" />
          </button>
        </div>

        <template v-if="c.varyColor">
          <div class="text-[9px] uppercase tracking-[0.1em] text-white/35 mb-1">Palette</div>
          <VaryPalette class="mb-3" :model-value="c.varyPalette"
            @update:model-value="up({ varyPalette: $event })" />
          <div class="text-[9px] uppercase tracking-[0.1em] text-white/35 mb-1">Spread</div>
          <div data-test="vary-spread" class="flex items-center gap-1 p-0.5 rounded-md bg-white/[0.05] mb-3">
            <button
              v-for="o in VARY_SPREAD_OPTIONS" :key="o.value"
              class="flex-1 h-7 rounded text-[11px] cursor-pointer transition-colors"
              :class="c.varyColorSpread === o.value ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'"
              :title="o.value === 'cycle' ? 'Each copy takes one whole palette colour' : 'Fade between the palette colours'"
              @click="up({ varyColorSpread: o.value })"
            >{{ o.label }}</button>
          </div>
          <label data-test="vary-strength" class="block">
            <span class="text-[9px] uppercase tracking-[0.1em] text-white/35 block mb-1">Colour strength</span>
            <input v-scrubnum type="number" min="0" max="1" step="0.01" :value="c.varyColorStrength"
              class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white/90 outline-none"
              @input="up({ varyColorStrength: Math.max(0, Math.min(1, num($event))) })" />
          </label>
        </template>
      </div>
    </template>
  </div>
</template>
