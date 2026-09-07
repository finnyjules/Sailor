<!-- frontend/app/components/vue-canvas/PostEffectsControls.vue -->
<script lang="ts">
// The sections this panel draws, and the kinds they cover. Declared in a plain script
// block, not in `<script setup>`, so the list can be EXPORTED: the Compositor's effect
// inspector asks "is there a panel for this kind?" and must not keep a second copy that
// drifts when a section is added here.
import type { PostEffect } from '~/lib/compositor/postEffects'

interface ParamSpec { key: string; label: string; min: number; max: number; step: number }
interface SectionSpec { type: PostEffect['type']; label: string; params: ParamSpec[]; colors?: [string, string][]; ramp?: boolean }
const SECTIONS: SectionSpec[] = [
  { type: 'adjust', label: 'Adjust', params: [
    { key: 'brightness', label: 'Brightness', min: 0, max: 2, step: 0.01 },
    { key: 'contrast', label: 'Contrast', min: 0, max: 2, step: 0.01 },
    { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01 },
    { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1 },
  ] },
  { type: 'bloom', label: 'Bloom', params: [
    { key: 'threshold', label: 'Threshold', min: 0, max: 1, step: 0.01 },
    { key: 'radius', label: 'Radius', min: 0, max: 0.5, step: 0.005 },
    { key: 'intensity', label: 'Intensity', min: 0, max: 2, step: 0.01 },
  ] },
  { type: 'grain', label: 'Grain', params: [
    { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01 },
    { key: 'size', label: 'Size', min: 1, max: 8, step: 0.5 },
  ] },
  { type: 'vignette', label: 'Vignette', params: [
    { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01 },
    { key: 'size', label: 'Size', min: 0, max: 1, step: 0.01 },
    { key: 'softness', label: 'Softness', min: 0, max: 1, step: 0.01 },
  ] },
  { type: 'duotone', label: 'Duotone', colors: [['shadows', 'Shadows'], ['highlights', 'Highlights']], params: [
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01 },
  ] },
  { type: 'gradientMap', label: 'Gradient map', ramp: true, params: [
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01 },
    { key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01 },
  ] },
  // Blades < 3 renders a circular iris; 6 gives hexagonal bokeh. Highlight boost is
  // what turns bright defocused points into discs rather than grey mush.
  { type: 'dof', label: 'Depth of field', params: [
    { key: 'focus', label: 'Focus', min: 0, max: 1, step: 0.01 },
    { key: 'range', label: 'Sharp band', min: 0, max: 1, step: 0.01 },
    { key: 'aperture', label: 'Aperture', min: 0, max: 1, step: 0.005 },
    { key: 'bladeCount', label: 'Blades', min: 0, max: 12, step: 1 },
    { key: 'bladeRotation', label: 'Blade angle', min: 0, max: 360, step: 1 },
    { key: 'bloomThreshold', label: 'Highlight', min: 0, max: 1, step: 0.01 },
    { key: 'bloomStrength', label: 'Boost', min: 0, max: 4, step: 0.05 },
  ] },
]

/** The effect kinds this component has a section for. */
export const PANEL_EFFECT_KINDS: PostEffect['type'][] = SECTIONS.map(s => s.type)
</script>

<script setup lang="ts">
// Post-processing effect sections (adjust/bloom/grain/vignette/duotone/dof).
// Emits the FULL replacement chain array — the owner decides where it lives
// (layer.effects for a layer, sailor_localFx for the document).
//
// `depthSource` gates the Depth of Field section: it runs on the GPU against a depth
// map, so it is only offered where one can exist. A bare filename means input/ (an
// uploaded layer); a wired layer passes its full source.
//
// `only` restricts which sections are offered. Wired layers pass ['dof'] because the 2D
// chain is not applied on their draw path yet — offering Vignette there would write a
// setting that silently never renders.
//
// `hideToggle` drops the per-section Add/Remove button. The Compositor's effect inspector
// shows ONE existing instance, where adding is the layer tree's plus menu and removing is
// the row's trash icon — the button there would emit a chain this owner ignores, i.e. read
// as a button that does nothing.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
// `PostEffect` is imported by the plain script block above — the two blocks share one
// module scope, so importing it twice is a duplicate identifier.
import { defaultPostEffect, type GradientMapStop } from '~/lib/compositor/postEffects'
import { dofAvailable, dofUnavailableReason } from '~/lib/compositor/dofPass'
import {
  depthMessageFor, depthStatusFor, onDepthChange, requestDepth, type DepthRef,
} from '~/lib/compositor/depthRegistry'
import StudioGradientRamp from '~/components/vue-canvas/studio/StudioGradientRamp.vue'
import PalettePicker from '~/components/vue-canvas/studio/PalettePicker.vue'
import type { GradientStop } from '~/lib/color/harmony'

const props = defineProps<{
  effects: PostEffect[]
  depthSource?: DepthRef
  only?: PostEffect['type'][]
  hideToggle?: boolean
}>()
const emit = defineEmits<{ (e: 'update', effects: PostEffect[]): void }>()

// The registry is a plain module, not reactive — bump a counter on change so the
// status line re-renders when depth arrives or fails.
const depthTick = ref(0)
let stopDepthWatch: (() => void) | null = null
onMounted(() => { stopDepthWatch = onDepthChange(() => { depthTick.value++ }) })
onBeforeUnmount(() => { stopDepthWatch?.(); stopDepthWatch = null })

const glOk = computed(() => dofAvailable())
const glReason = computed(() => dofUnavailableReason())
const depthStatus = computed(() => {
  void depthTick.value
  return props.depthSource ? depthStatusFor(props.depthSource) : 'idle'
})
const depthMessage = computed(() => {
  void depthTick.value
  return props.depthSource ? depthMessageFor(props.depthSource) : ''
})
function retryDepth() { if (props.depthSource) requestDepth(props.depthSource) }

// With the toggle hidden and exactly one section offered, the owner has already named the
// effect (the inspector's breadcrumb does), so a section title would just repeat it.
const showSectionTitle = computed(() => !(props.hideToggle && props.only?.length === 1))


// Depth of field needs a depth map, so it is offered only where one can exist.
const sections = computed(() => SECTIONS.filter(s =>
  (!props.only || props.only.includes(s.type))
  && (s.type !== 'dof' || !!props.depthSource)))

function fx(type: string): Record<string, any> | undefined {
  return props.effects.find(e => e.type === type) as Record<string, any> | undefined
}
function toggle(type: PostEffect['type']) {
  if (fx(type)) emit('update', props.effects.filter(e => e.type !== type))
  else emit('update', [...props.effects, defaultPostEffect(type)])
}
function patch(type: PostEffect['type'], key: string, value: number | string | GradientMapStop[]) {
  const cur = (fx(type) ?? defaultPostEffect(type)) as Record<string, any>
  emit('update', [
    ...props.effects.filter(e => e.type !== type),
    { ...cur, [key]: value } as PostEffect,
  ])
}
function fmt(v: unknown, step: number): string {
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(step >= 1 ? 0 : 2) : '—'
}
</script>

<template>
  <div>
    <div v-for="s in sections" :key="s.type" class="mt-3 first:mt-0">
      <div v-if="showSectionTitle || !hideToggle" class="flex items-center justify-between mb-1.5">
        <div v-if="showSectionTitle" class="panel-label">{{ s.label }}</div>
        <button v-if="!hideToggle" class="text-[10px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-white/60 hover:text-white/90"
          :data-testid="`postfx-add-${s.type}`"
          @click="toggle(s.type)">{{ fx(s.type) ? 'Remove' : 'Add' }}</button>
      </div>
      <!-- Depth of field states its own preconditions. It never falls back to a 2D
           blur: a plausible-looking substitute would hide a broken integration. -->
      <template v-if="s.type === 'dof' && fx('dof')">
        <div v-if="!glOk" data-testid="dof-status-nogl"
          class="mb-1.5 text-[10px] leading-snug text-amber-400/80">
          Depth of field needs WebGL2, which isn’t available here.
          <span v-if="glReason" class="text-white/40">({{ glReason }})</span>
        </div>
        <div v-else-if="depthStatus === 'loading'" data-testid="dof-status-loading"
          class="mb-1.5 text-[10px] text-white/50">Reading depth…</div>
        <div v-else-if="depthStatus === 'error'" data-testid="dof-status-error"
          class="mb-1.5 text-[10px] leading-snug text-amber-400/80">
          {{ depthMessage || 'Depth couldn’t be read.' }}
          <button class="underline text-white/60 hover:text-white/90 ml-1"
            data-testid="dof-retry" @click="retryDepth">Retry</button>
        </div>
      </template>
      <div v-if="fx(s.type)" class="space-y-1.5">
        <div v-if="s.colors" class="flex items-center gap-1.5">
          <div v-for="[key, label] in s.colors" :key="key" class="flex-1 flex items-center gap-1.5 min-w-0">
            <input type="color" :value="fx(s.type)![key]" :title="label"
              class="w-8 h-8 rounded bg-transparent border border-[#2a2a2a] cursor-pointer shrink-0"
              @input="patch(s.type, key, ($event.target as HTMLInputElement).value)" />
            <div class="panel-sublabel truncate">{{ label }}</div>
          </div>
        </div>
        <StudioGradientRamp
          v-if="s.ramp"
          :model-value="(fx(s.type)!.stops as GradientMapStop[])"
          @update:model-value="(v: GradientMapStop[]) => patch(s.type, 'stops', v)"
        />
        <PalettePicker
          v-if="s.ramp"
          mode="stops"
          :stop-count="(fx(s.type)!.stops as GradientMapStop[]).length"
          :seed="(fx(s.type)!.stops as GradientMapStop[])[0]?.color ?? '#4f8ad9'"
          @apply-stops="(v: GradientStop[]) => patch(s.type, 'stops', v)"
          @apply-literal-stops="(v: GradientStop[]) => patch(s.type, 'stops', v)"
        />
        <div v-for="p in s.params" :key="p.key" class="flex items-center gap-2">
          <div class="panel-sublabel w-16 shrink-0">{{ p.label }}</div>
          <input type="range" :min="p.min" :max="p.max" :step="p.step" :value="fx(s.type)![p.key]"
            class="flex-1 min-w-0 accent-white/80 cursor-pointer"
            :data-testid="`postfx-${s.type}-${p.key}`"
            @input="patch(s.type, p.key, parseFloat(($event.target as HTMLInputElement).value))" />
          <div class="w-9 shrink-0 text-right text-[10px] text-white/50 tabular-nums">{{ fmt(fx(s.type)![p.key], p.step) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
