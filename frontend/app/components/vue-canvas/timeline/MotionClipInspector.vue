<script setup lang="ts">
import type { MotionClip, MotionTextLayer } from '~~/shared/timeline/types'
import { presetIdsFor } from '~/lib/motion/evaluate'
import { VARIABLE_FONTS } from '~/data/variable-fonts'
import { normalizeAxisKeyframes } from '~/lib/timeline/convertPresetToKeyframes'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'

const props = defineProps<{ clip: MotionClip }>()
const emit = defineEmits<{ update: [patch: Partial<MotionClip>] }>()

const L = () => props.clip.layer
function patchLayer(p: Partial<MotionTextLayer>) {
  emit('update', { layer: { ...L(), ...p } })
}
function patchAnim(key: 'in' | 'out' | 'loop', presetId: string) {
  const anim = { ...(L().animation ?? {}) } as NonNullable<MotionTextLayer['animation']>
  anim[key] = presetId
    ? { duration: key === 'loop' ? 1.5 : 0.6, stagger: 0.04, ...(anim[key] ?? {}), presetId }
    : undefined
  patchLayer({ animation: anim })
}
function patchAxis(tag: string, v: number) {
  patchLayer({ axes: { ...(L().axes ?? {}), [tag]: v } })
}

/** Normalize the layer's axisKeyframes so the keyframe dock can edit them. */
function convertToKeyframes() {
  patchLayer({ axisKeyframes: normalizeAxisKeyframes(L().axisKeyframes) })
}

const fontDef = () => VARIABLE_FONTS.find(f => f.family === L().fontFamily)

// Motion clips render through drawAnimatedTextLayer, which reads no optional
// UnitState field beyond clip/copies — no blur, no per-unit axes. So this
// inspector declares nothing and gets the conservative preset set.
const slotIds = (key: 'in' | 'out' | 'loop') => presetIdsFor(key)
</script>

<template>
  <div class="space-y-3 text-xs">
    <label class="block space-y-1">
      <span class="text-[10px] uppercase tracking-[0.12em] text-white/40">Text</span>
      <textarea
        :value="clip.layer.text"
        rows="2"
        class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none resize-y"
        @change="patchLayer({ text: ($event.target as HTMLTextAreaElement).value })"
      />
    </label>

    <div class="grid grid-cols-2 gap-2">
      <label class="space-y-1">
        <span class="text-[10px] uppercase tracking-[0.12em] text-white/40">Font</span>
        <select
          class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none"
          :value="clip.layer.fontFamily"
          @change="patchLayer({ fontFamily: ($event.target as HTMLSelectElement).value })"
        >
          <option v-for="f in VARIABLE_FONTS" :key="f.id" :value="f.family">{{ f.label }}</option>
        </select>
      </label>

      <label class="space-y-1">
        <span class="text-[10px] uppercase tracking-[0.12em] text-white/40">Size</span>
        <input
          type="number"
          min="0.01"
          max="0.5"
          step="0.005"
          :value="clip.layer.fontSize"
          class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
          @change="patchLayer({ fontSize: Number(($event.target as HTMLInputElement).value) || 0.1 })"
        />
      </label>
    </div>

    <label class="flex items-center justify-between gap-2">
      <span class="text-[10px] uppercase tracking-[0.12em] text-white/40">Color</span>
      <input
        type="color"
        class="h-7 w-12 bg-transparent rounded cursor-pointer"
        :value="clip.layer.color"
        @change="patchLayer({ color: ($event.target as HTMLInputElement).value })"
      />
    </label>

    <div v-if="fontDef()" class="space-y-1.5 pt-2 border-t border-white/5">
      <div class="text-[10px] uppercase tracking-[0.12em] text-white/40">Axes</div>
      <div v-for="ax in fontDef()!.axes" :key="ax.tag" class="space-y-1">
        <StudioSlider
          :model-value="clip.layer.axes?.[ax.tag] ?? ax.default"
          @update:model-value="(v) => patchAxis(ax.tag, v)"
          :label="ax.label"
          :min="ax.min"
          :max="ax.max"
          :step="ax.step ?? 1"
          :bindable="false"
        />
      </div>
      <button
        type="button"
        class="mt-1 w-full text-left text-[10px] text-white/70 hover:text-white transition-colors"
        @click="convertToKeyframes"
      >
        Edit axis animation in keyframe dock ↓
      </button>
    </div>

    <div class="space-y-1.5 pt-2 border-t border-white/5">
      <div class="text-[10px] uppercase tracking-[0.12em] text-white/40">Animation</div>
      <label
        v-for="key in (['in', 'out', 'loop'] as const)"
        :key="key"
        class="flex items-center justify-between gap-2"
      >
        <span class="capitalize text-white/60">{{ key }}</span>
        <select
          class="w-36 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none"
          :value="clip.layer.animation?.[key]?.presetId ?? ''"
          @change="patchAnim(key, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">none</option>
          <option
            v-for="id in slotIds(key)"
            :key="id"
            :value="id"
          >{{ id }}</option>
        </select>
      </label>
    </div>
  </div>
</template>
