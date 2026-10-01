<script setup lang="ts">
/**
 * The "Light and shadow" card for a selected non-light layer (Frame light layers, stage 1): Lit by
 * lights, Casts shadows and, while it casts, Lift. The host shows it only while the Frame has a
 * light. Writes go out as `change(patch, record)`; a value equal to the kind's default is written
 * as `undefined` (absent = default), so a Frame stores nothing it does not need.
 */
import { computed } from 'vue'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import type { LocalLayerKind } from '~/composables/useCompositorLayers'
import { defaultCastsShadow, defaultLift, effectiveCasts, effectiveLift, effectiveLit } from '~/lib/frame/lighting/settings'
import { nudgeLightingDrag } from '~/lib/frame/lighting/drag'
import { sliderGesture } from '~/lib/frame/lighting/gesture'

type Switches = { lit?: boolean; castsShadow?: boolean; lift?: number }
const props = defineProps<{ layer: { kind: LocalLayerKind } & Switches }>()
const emit = defineEmits<{ change: [patch: Switches, record: boolean] }>()

const lit = computed(() => effectiveLit(props.layer))
const casts = computed(() => effectiveCasts(props.layer))
/** Lift in % of the Frame width (0.5–15), as the prototype shows it. */
const liftPct = computed(() => Math.round(effectiveLift(props.layer) * 1000) / 10)
const gesture = sliderGesture()

function setLit(v: boolean) { emit('change', { lit: v ? undefined : false }, true) }
function setCasts(v: boolean) { emit('change', { castsShadow: v === defaultCastsShadow(props.layer.kind) ? undefined : v }, true) }
function setLift(v: number) {
  nudgeLightingDrag()
  const lift = Math.min(0.15, Math.max(0.005, v / 100))
  emit('change', { lift: Math.abs(lift - defaultLift(props.layer.kind)) < 1e-9 ? undefined : lift }, gesture.take())
}
</script>

<template>
  <StudioSection title="Light and shadow">
    <div class="flex flex-col gap-1.5" data-testid="light-and-shadow">
      <div data-testid="layer-lit">
        <StudioSwitch label="Lit by lights" hint="Off keeps this layer flat, whatever the lights do"
          :model-value="lit" @update:model-value="setLit" />
      </div>
      <div data-testid="layer-casts-shadow">
        <StudioSwitch label="Casts shadows" hint="This layer floats a little above what is beneath it and casts shadows from every light"
          :model-value="casts" @update:model-value="setCasts" />
      </div>
      <div v-if="casts" data-testid="layer-lift" @pointerdown.capture="gesture.start()">
        <StudioSlider label="Lift" hint="How far this layer floats above the one beneath. Higher casts a longer shadow"
          :min="0.5" :max="15" :step="0.5" :default="Math.round(defaultLift(layer.kind) * 1000) / 10" :bindable="false"
          :model-value="liftPct" @update:model-value="setLift" />
      </div>
    </div>
  </StudioSection>
</template>
