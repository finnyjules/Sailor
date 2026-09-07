<!-- frontend/app/components/vue-canvas/compositor/CompositorTornEdgePanel.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import { DEFAULT_TORN_EDGE, TORN_EDGE_STYLES, type TornEdgeSpec, type TornEdgeStyle } from '~/lib/compositor/tornEdge'

// The stored value stays the slug; only the option text is human.
const STYLE_LABELS: Record<TornEdgeStyle, string> = {
  ripped: 'Ripped',
  deckle: 'Deckle',
  shredded: 'Shredded',
}

// `hideToggle` drops the header's Add/Remove. The Compositor's effect inspector shows one
// existing instance and owns add/remove from the layer tree, so the button would be inert.
const props = defineProps<{ value?: TornEdgeSpec, hideToggle?: boolean }>()
const emit = defineEmits<{
  (e: 'update', patch: Partial<TornEdgeSpec>): void
  (e: 'toggle', on: boolean): void
}>()

const on = computed(() => !!props.value)
const v = computed<TornEdgeSpec>(() => props.value ?? DEFAULT_TORN_EDGE)
const set = (patch: Partial<TornEdgeSpec>) => emit('update', patch)
const reseed = () => emit('update', { seed: Math.floor(Math.abs(Math.sin(v.value.seed + 1) * 99999)) + 1 })
</script>

<template>
  <div>
    <div v-if="!hideToggle" class="flex items-center justify-between mb-1.5">
      <div class="panel-label">Torn edge</div>
      <button type="button" class="text-[10px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-white/60 hover:text-white/90"
        @click="emit('toggle', !on)">{{ on ? 'Remove' : 'Add' }}</button>
    </div>

    <template v-if="on">
      <div class="space-y-2">
        <div>
          <div class="panel-label mb-1.5">Edge style</div>
          <select :value="v.style"
            class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none cursor-pointer"
            @change="set({ style: ($event.target as HTMLSelectElement).value as TornEdgeSpec['style'] })">
            <option v-for="st in TORN_EDGE_STYLES" :key="st" :value="st">{{ STYLE_LABELS[st] ?? st }}</option>
          </select>
        </div>

        <div>
          <div class="flex items-center justify-between panel-sublabel mb-1"><span>Tear depth</span><span class="tabular-nums normal-case">{{ v.amount }}</span></div>
          <input type="range" min="0" max="70" step="1" :value="v.amount" class="w-full accent-white cursor-pointer"
            @input="set({ amount: +($event.target as HTMLInputElement).value })">
        </div>

        <div>
          <div class="flex items-center justify-between panel-sublabel mb-1"><span>Roughness</span><span class="tabular-nums normal-case">{{ Math.round(v.roughness * 100) }}</span></div>
          <input type="range" min="0" max="100" step="1" :value="Math.round(v.roughness * 100)" class="w-full accent-white cursor-pointer"
            @input="set({ roughness: +($event.target as HTMLInputElement).value / 100 })">
        </div>

        <div>
          <div class="flex items-center justify-between panel-sublabel mb-1"><span>Grain</span><span class="tabular-nums normal-case">{{ v.grain }}</span></div>
          <input type="range" min="0" max="18" step="1" :value="v.grain" class="w-full accent-white cursor-pointer"
            @input="set({ grain: +($event.target as HTMLInputElement).value })">
        </div>

        <div>
          <div class="flex items-center justify-between panel-sublabel mb-1"><span>Grain texture</span><span class="tabular-nums normal-case">{{ Math.round(v.grainTexture * 100) }}</span></div>
          <input type="range" min="0" max="100" step="1" :value="Math.round(v.grainTexture * 100)" class="w-full accent-white cursor-pointer"
            @input="set({ grainTexture: +($event.target as HTMLInputElement).value / 100 })">
        </div>

        <div>
          <div class="flex items-center justify-between panel-sublabel mb-1"><span>Lip width</span><span class="tabular-nums normal-case">{{ v.lipWidth }}</span></div>
          <input type="range" min="0" max="20" step="1" :value="v.lipWidth" class="w-full accent-white cursor-pointer"
            @input="set({ lipWidth: +($event.target as HTMLInputElement).value })">
        </div>

        <div>
          <div class="flex items-center justify-between panel-sublabel mb-1"><span>Lip width var</span><span class="tabular-nums normal-case">{{ Math.round(v.lipVariation * 100) }}</span></div>
          <input type="range" min="0" max="100" step="1" :value="Math.round(v.lipVariation * 100)" class="w-full accent-white cursor-pointer"
            @input="set({ lipVariation: +($event.target as HTMLInputElement).value / 100 })">
        </div>

        <div class="flex items-center justify-between">
          <div class="panel-label">Lip color</div>
          <input type="color" :value="v.lipColor"
            class="w-8 h-8 rounded bg-transparent border border-[#2a2a2a] cursor-pointer shrink-0"
            @input="set({ lipColor: ($event.target as HTMLInputElement).value })">
        </div>

        <button type="button" class="text-[10px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-white/60 hover:text-white/90"
          @click="reseed">New tear</button>
      </div>
    </template>
  </div>
</template>
