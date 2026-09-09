<script setup lang="ts">
/** Motion-tab inspector for the selected layer: In/Loop/Out slot chips that
 *  open the preset gallery, plus timing + per-preset param sliders. Emits the
 *  whole next LayerAnimation (parent persists via setLocal, as before). */
import type { LayerAnimation, LayerAnimSpec } from '~/lib/motion/types'
import type { PresetCapability } from '~/lib/motion/evaluate'
import { KINETIC_PRESETS_BY_ID, presetParamDefault } from '~/data/kinetic-presets'
import MotionPresetPicker from '~/components/vue-canvas/motion/MotionPresetPicker.vue'
import PresetThumb from '~/components/vue-canvas/motion/PresetThumb.vue'
import { X } from 'lucide-vue-next'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'

const props = defineProps<{ animation: LayerAnimation | undefined; frameDuration: number; layerKind?: string }>()
const emit = defineEmits<{ update: [anim: LayerAnimation | undefined] }>()

/**
 * What `paint.ts` can draw for THIS layer, in the engine's vocabulary.
 *
 * `copies` (echo trails, tiled marquees) are extra whole-unit draws. The painter
 * makes them for a whole-layer sample but not for per-char text — so a text
 * layer declares nothing and the four copy-based presets are withheld, exactly
 * as the picker's own private list used to do it. Blur is still unwired in
 * `paint.ts` for every kind, so it is declared by nobody here.
 */
const capabilities = computed<PresetCapability[]>(() => (props.layerKind === 'text' ? [] : ['copies']))

const SLOTS = ['in', 'loop', 'out'] as const
type SlotKind = typeof SLOTS[number]

const pickerFor = ref<SlotKind | null>(null)
const pickerAnchor = ref<{ top: number; left: number; width: number } | null>(null)
function openPicker(slot: SlotKind, e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  pickerAnchor.value = { top: r.top, left: r.left, width: r.width }
  pickerFor.value = slot
}

const label = (id: string) => KINETIC_PRESETS_BY_ID[id]?.label ?? id
const paramSchema = (id: string) => KINETIC_PRESETS_BY_ID[id]?.params ?? []

function patch(p: Partial<LayerAnimation>) {
  emit('update', { offset: 0, ...(props.animation ?? {}), ...p })
}
function assign(slot: SlotKind, presetId: string) {
  const cur: LayerAnimSpec = props.animation?.[slot] ?? { presetId, duration: slot === 'loop' ? 1.5 : 0.8, stagger: 0.04 }
  patch({ [slot]: { ...cur, presetId, params: undefined } })  // params reset on preset change
  pickerFor.value = null
}
function clearSlot(slot: SlotKind) {
  patch({ [slot]: undefined })
  pickerFor.value = null
}
function patchSpecNum(slot: SlotKind, field: 'duration' | 'stagger', v: number) {
  const cur = props.animation?.[slot]
  if (cur) patch({ [slot]: { ...cur, [field]: v } })
}
function patchParam(slot: SlotKind, key: string, v: number) {
  const cur = props.animation?.[slot]
  if (cur) patch({ [slot]: { ...cur, params: { ...(cur.params ?? {}), [key]: v } } })
}
const paramValue = (spec: LayerAnimSpec, key: string) => spec.params?.[key] ?? presetParamDefault(spec.presetId, key)
</script>

<template>
  <div class="flex flex-col gap-3 text-xs">
    <div class="flex items-center justify-between">
      <span class="text-[10px] uppercase tracking-[0.12em] text-white/40">Animation</span>
      <button v-if="animation" class="text-[10px] px-1.5 py-0.5 rounded border border-white/10 text-white/60 hover:text-white/90 cursor-pointer"
        @click="emit('update', undefined)">Clear all</button>
    </div>

    <!-- Window timing (mirrors the band) -->
    <div class="grid grid-cols-2 gap-2">
      <label class="flex flex-col gap-1 text-white/55">Start (s)
        <input v-scrubnum type="number" min="0" step="0.1" :value="animation?.offset ?? 0"
          class="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-1.5 py-1 text-white/90 outline-none"
          @change="patch({ offset: Math.max(0, Number(($event.target as HTMLInputElement).value) || 0) })">
      </label>
      <label class="flex flex-col gap-1 text-white/55">Duration (s)
        <input v-scrubnum type="number" min="0.1" step="0.1" :value="animation?.duration ?? ''" placeholder="to end"
          class="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-1.5 py-1 text-white/90 outline-none"
          @change="(e: Event) => { const v = (e.target as HTMLInputElement).value; patch({ duration: v === '' ? undefined : Math.max(0.1, Number(v) || 0.1) }) }">
      </label>
    </div>

    <!-- Slot chips -->
    <div v-for="slot in SLOTS" :key="slot" class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between">
        <span class="capitalize text-white/55">{{ slot }}</span>
        <button v-if="animation?.[slot]" class="text-white/35 hover:text-white/75 cursor-pointer" :title="`Clear ${slot}`"
          @click="clearSlot(slot)"><X class="size-3" /></button>
      </div>
      <button class="flex items-center gap-2 rounded-lg border p-1.5 text-left cursor-pointer transition-colors"
        :class="animation?.[slot] ? 'border-white/25 bg-white/[0.06]' : 'border-dashed border-white/[0.12] bg-white/[0.02] hover:bg-white/[0.05]'"
        @click="(e: MouseEvent) => openPicker(slot, e)">
        <div class="w-14 shrink-0"><PresetThumb v-if="animation?.[slot]" :preset-id="animation[slot]!.presetId" :slot-kind="slot" :params="animation[slot]!.params" /></div>
        <span :class="animation?.[slot] ? 'text-white/90' : 'text-white/40'">
          {{ animation?.[slot] ? label(animation[slot]!.presetId) : `Choose ${slot} preset…` }}
        </span>
      </button>
      <div v-if="animation?.[slot]" class="flex flex-col gap-1.5 pl-1">
        <div class="flex gap-2 text-white/55">
          <label class="flex items-center gap-1">dur
            <input v-scrubnum type="number" min="0.1" step="0.1" :value="animation[slot]!.duration"
              class="w-14 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-1 py-0.5 text-white/90 outline-none"
              @change="patchSpecNum(slot, 'duration', Math.max(0.1, Number(($event.target as HTMLInputElement).value) || 0.8))">
          </label>
          <label v-if="layerKind === 'text'" class="flex items-center gap-1">stagger
            <input v-scrubnum type="number" min="0" step="0.01" :value="animation[slot]!.stagger ?? 0.04"
              class="w-14 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-1 py-0.5 text-white/90 outline-none"
              @change="patchSpecNum(slot, 'stagger', Math.max(0, Number(($event.target as HTMLInputElement).value) || 0))">
          </label>
        </div>
        <StudioSlider
          v-for="ps in paramSchema(animation[slot]!.presetId)" :key="ps.key"
          :model-value="paramValue(animation[slot]!, ps.key)"
          @update:model-value="(v) => patchParam(slot, ps.key, v)"
          :label="ps.label"
          :min="ps.min"
          :max="ps.max"
          :step="ps.step"
          :bindable="false"
        />
      </div>
    </div>

    <MotionPresetPicker v-if="pickerFor"
      :slot-kind="pickerFor" :current-id="animation?.[pickerFor]?.presetId ?? null" :anchor-rect="pickerAnchor"
      :capabilities="capabilities"
      @pick="(id: string) => assign(pickerFor!, id)" @clear="clearSlot(pickerFor!)" @close="pickerFor = null" />
  </div>
</template>
