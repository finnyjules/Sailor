<script setup lang="ts">
/**
 * A layer row's two light switches (Frame light layers, stage 1): the shadow toggle and the bulb.
 * Hover-revealed like Lock / Visibility; a switch that differs from the layer kind's default stays
 * in view. The host shows them only while the Frame has a light, never on a light's own row.
 */
import { computed } from 'vue'
import { Lightbulb } from 'lucide-vue-next'
import type { LocalLayerKind } from '~/composables/useCompositorLayers'
import { defaultCastsShadow, effectiveCasts, effectiveLit } from '~/lib/frame/lighting/settings'

const props = defineProps<{ layer: { kind: LocalLayerKind; lit?: boolean; castsShadow?: boolean } }>()
const emit = defineEmits<{ 'toggle-lit': []; 'toggle-casts': [] }>()

const lit = computed(() => effectiveLit(props.layer))
const casts = computed(() => effectiveCasts(props.layer))
const litOff = computed(() => !lit.value)
const castsOff = computed(() => casts.value !== defaultCastsShadow(props.layer.kind))
const base = 'shrink-0 transition cursor-pointer rounded focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
</script>

<template>
  <button type="button" data-testid="row-casts-shadow" :aria-pressed="casts" aria-label="Casts shadows"
    :class="[base, casts ? 'text-violet-200/90' : 'text-white/35 hover:text-white/80', castsOff ? '' : 'opacity-0 group-hover/row:opacity-100']"
    :title="casts ? 'Casts shadows. Click to stop' : 'No shadow. Click to let this layer cast shadows'"
    @click.stop="emit('toggle-casts')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" class="size-3.5" aria-hidden="true">
      <rect x="3" y="3" width="12" height="12" rx="2" />
      <path d="M19 8v9a2 2 0 0 1-2 2H8" stroke-opacity="0.9" />
      <path d="M21 11v6a4 4 0 0 1-4 4h-6" stroke-opacity="0.45" />
    </svg>
  </button>
  <button type="button" data-testid="row-lit" :aria-pressed="lit" aria-label="Lit by lights"
    :class="[base, lit ? 'text-amber-200/90' : 'text-white/35 hover:text-white/80', litOff ? '' : 'opacity-0 group-hover/row:opacity-100']"
    :title="lit ? 'Lit by lights. Click to keep this layer flat' : 'Not lit. Click to let lights reach this layer'"
    @click.stop="emit('toggle-lit')">
    <Lightbulb class="size-3.5" />
  </button>
</template>
