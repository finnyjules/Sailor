<script setup lang="ts">
/**
 * The light inspector (Frame light layers, stage 1): what a selected light layer shows in place of
 * every generic card. Lamp / Spot / Sun, Colour, Brightness, Height, Reach (lamp, spot), Cone and
 * Edge (spot), Delete light, then the "All lights" card with Darkness. Lights take no effects,
 * masks or clones, so none of those cards appear here.
 *
 * Writes go out as `change(patch, record)`: `record` is true for the first write of a slider
 * gesture (and for every click), so each gesture is one undo step. Every dial write also nudges
 * the lighting drag flag, so a drag repaints through the capped preview.
 */
import { computed } from 'vue'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import LightDarknessSlider from '~/components/vue-canvas/compositor/LightDarknessSlider.vue'
import { LIGHT_DEFAULTS, type LightLayer, type LightParams, type LightType } from '~/lib/frame/lighting/settings'
import { nudgeLightingDrag } from '~/lib/frame/lighting/drag'
import { sliderGesture } from '~/lib/frame/lighting/gesture'
import {
  LIGHT_TYPES, LIGHT_TYPE_LABELS, LIGHT_SWATCHES, lightHex,
  CONE_DEG_MIN, CONE_DEG_MAX, coneToDeg, degToCone,
} from '~/lib/frame/lighting/labels'

const props = withDefaults(defineProps<{
  light: LightLayer
  darkness: number
  /** False shows the one muted note: the lighting pass cannot run on this machine. */
  available?: boolean
}>(), { available: true })
const emit = defineEmits<{
  change: [patch: Partial<LightParams>, record: boolean]
  darkness: [value: number, record: boolean]
  delete: []
}>()

const p = computed(() => props.light.light)
const d = computed(() => LIGHT_DEFAULTS[p.value.type])
const gesture = sliderGesture()

/** Switching kind keeps the light where it is (x / y are the layer's, untouched) and its dials. */
function setType(v: string) {
  const t = v as LightType
  if (t !== p.value.type && LIGHT_TYPES.includes(t)) emit('change', { type: t }, true)
}
function setColor(v: string) {
  const hex = lightHex(v)
  if (hex && hex !== p.value.color) emit('change', { color: hex }, true)
}
/** The picker writes on every move of its pad: one undo step per run of writes (300 ms quiet). */
let pickedAt = -Infinity
function pickColor(v: string) {
  const hex = lightHex(v)
  if (!hex || hex === p.value.color) return
  const now = performance.now()
  const record = now - pickedAt >= 300
  pickedAt = now
  nudgeLightingDrag()
  emit('change', { color: hex }, record)
}
function dial(patch: Partial<LightParams>) {
  nudgeLightingDrag()
  emit('change', patch, gesture.take())
}
const pct = (v: number) => Math.round(v * 100)
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="light-inspector">
    <StudioSection title="Light">
      <div class="flex flex-col gap-2.5">
        <p v-if="!available" class="text-[11px] text-white/40" data-testid="light-unavailable">Lights need graphics acceleration</p>
        <div data-testid="light-type">
          <StudioSegmented :options="LIGHT_TYPES" :option-labels="LIGHT_TYPES.map(t => LIGHT_TYPE_LABELS[t])"
            :model-value="p.type" @update:model-value="setType" />
        </div>
        <div>
          <div class="panel-label mb-1.5">Colour</div>
          <div class="flex flex-wrap items-center gap-1.5" data-testid="light-colours">
            <button v-for="c in LIGHT_SWATCHES" :key="c" type="button" data-testid="light-swatch" :data-color="c"
              :aria-label="`Colour ${c}`" :aria-pressed="p.color === c"
              class="size-5 rounded-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              :class="p.color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-[#151517]' : ''"
              :style="{ background: c }" @click="setColor(c)" />
            <span data-testid="light-any-colour" title="Any colour">
              <StudioColor :model-value="p.color" @update:model-value="pickColor" />
            </span>
          </div>
        </div>
        <div class="flex flex-col gap-1.5" @pointerdown.capture="gesture.start()">
          <StudioSlider data-testid="light-brightness" label="Brightness" :min="0" :max="3" :step="0.05" :default="d.brightness" :bindable="false"
            :model-value="p.brightness" @update:model-value="(v: number) => dial({ brightness: Math.min(3, Math.max(0, v)) })" />
          <StudioSlider data-testid="light-height" label="Height" :min="0" :max="100" :step="1" :default="pct(d.height)" :bindable="false"
            :hint="p.type === 'sun' ? 'A low sun casts long shadows' : 'Low: grazing light and long shadows. High: overhead'"
            :model-value="pct(p.height)" @update:model-value="(v: number) => dial({ height: Math.min(1, Math.max(0, v / 100)) })" />
          <StudioSlider v-if="p.type !== 'sun'" data-testid="light-reach" label="Reach" :min="0.2" :max="2" :step="0.05" :default="d.reach" :bindable="false"
            hint="How far the light carries before it fades"
            :model-value="p.reach" @update:model-value="(v: number) => dial({ reach: Math.min(2, Math.max(0.2, v)) })" />
          <template v-if="p.type === 'spot'">
            <StudioSlider data-testid="light-cone" label="Cone" :min="CONE_DEG_MIN" :max="CONE_DEG_MAX" :step="1" :default="coneToDeg(d.cone)" :bindable="false"
              hint="The width of the pool, in degrees. Drag the ring on the canvas to aim it"
              :model-value="coneToDeg(p.cone)" @update:model-value="(v: number) => dial({ cone: degToCone(v) })" />
            <StudioSlider data-testid="light-edge" label="Edge" :min="0" :max="100" :step="1" :default="pct(d.edge)" :bindable="false"
              hint="A hard or soft edge to the pool"
              :model-value="pct(p.edge)" @update:model-value="(v: number) => dial({ edge: Math.min(1, Math.max(0, v / 100)) })" />
          </template>
        </div>
        <StudioButton class="w-full" variant="secondary" data-testid="light-delete" @click="emit('delete')">Delete light</StudioButton>
      </div>
    </StudioSection>
    <StudioSection title="All lights">
      <LightDarknessSlider :darkness="darkness" @update="(v, r) => emit('darkness', v, r)" />
    </StudioSection>
  </div>
</template>
