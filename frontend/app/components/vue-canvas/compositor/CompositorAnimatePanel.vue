<!-- frontend/app/components/vue-canvas/compositor/CompositorAnimatePanel.vue -->
<script setup lang="ts">
// Animate section for a selected image layer: prompt / model / length / Generate, and
// once a clip exists, Speed + Remove clip. Pure presentation — the modal owns the call.
import { computed, ref, watch } from 'vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import { CLIP_MODELS, clipModel, clipPriceUsd } from '~/data/clip-models'
import { CLIP_SPEED_MAX, CLIP_SPEED_MIN } from '~/lib/compositor/clip'
import type { ImageLayer } from '~/composables/useCompositorLayers'

const props = defineProps<{ layer: ImageLayer; busy: boolean; error: string }>()
const emit = defineEmits<{
  generate: [payload: { prompt: string; model: string; seconds: number }]
  speed: [value: number]
  remove: []
}>()

// Prefill through `clipModel`, never from the stored string directly: a clip made by a
// model that has since left the catalog (an id the <select> offers no option for) left
// the select BLANK and the price missing — v-model with no matching option renders
// nothing. Resolving to the first catalog row keeps the control and its price real.
const resolveModelId = (stored: string | undefined) => clipModel(stored ?? '')?.id ?? CLIP_MODELS[0]!.id

const prompt = ref(props.layer.clip?.prompt ?? '')
const model = ref(resolveModelId(props.layer.clip?.model))
const seconds = ref(clipModel(model.value)?.defaultDuration ?? 5)

const spec = computed(() => clipModel(model.value) ?? CLIP_MODELS[0]!)
watch(model, () => { if (!spec.value.durations.includes(seconds.value)) seconds.value = spec.value.defaultDuration })
watch(() => props.layer.id, () => {
  prompt.value = props.layer.clip?.prompt ?? ''
  model.value = resolveModelId(props.layer.clip?.model)
  // The `model` watcher above only fires when the id CHANGES; selecting a layer whose
  // model happens to match the one already showing leaves a length the new model may
  // not offer (a 12 s Seedance length on a Luma layer), so re-check it here too.
  if (!spec.value.durations.includes(seconds.value)) seconds.value = spec.value.defaultDuration
})

// Flat per-clip price — see clipPriceUsd: the hold does not scale with length.
const price = computed(() => {
  const usd = clipPriceUsd(model.value)
  return usd == null ? '' : `$${usd.toFixed(2)}`
})
const hasClip = computed(() => !!props.layer.clip)
const fieldCls = 'w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none'
</script>

<template>
  <div class="mt-3">
    <div class="panel-label">Animate</div>
    <div class="mt-2 flex flex-col gap-2">
      <div>
        <div class="panel-label mb-1.5">Prompt</div>
        <textarea v-model="prompt" rows="2" :class="fieldCls" placeholder="What should move, and how" />
      </div>
      <div>
        <div class="panel-label mb-1.5">Model</div>
        <select v-model="model" data-role="model" :class="fieldCls">
          <option v-for="m in CLIP_MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
        </select>
      </div>
      <div>
        <div class="panel-label mb-1.5">Length</div>
        <select v-model.number="seconds" data-role="length" :class="fieldCls">
          <option v-for="d in spec.durations" :key="d" :value="d">{{ d }} s</option>
        </select>
      </div>
      <button type="button" data-role="generate"
        class="text-xs px-2 py-1.5 rounded border border-white/[0.06] bg-[#2563eb]/30 text-white hover:bg-[#2563eb]/40 disabled:opacity-50"
        :disabled="busy"
        @click="emit('generate', { prompt: prompt.trim(), model, seconds })">
        {{ busy ? 'Generating…' : `Generate${price ? ' · ' + price : ''}` }}
      </button>
      <div v-if="error" class="text-[11px] text-red-300/90">{{ error }}</div>
      <template v-if="hasClip">
        <div data-role="speed">
          <StudioSlider :model-value="layer.clip!.speed" @update:model-value="(v: number) => emit('speed', v)"
            label="Speed" :min="CLIP_SPEED_MIN" :max="CLIP_SPEED_MAX" :step="0.05" :bindable="false" />
        </div>
        <button type="button" data-role="remove"
          class="text-xs px-2 py-1 rounded border border-white/[0.06] bg-white/[0.04] text-white/80 hover:bg-white/[0.06] self-start"
          @click="emit('remove')">
          Remove clip
        </button>
      </template>
    </div>
  </div>
</template>
