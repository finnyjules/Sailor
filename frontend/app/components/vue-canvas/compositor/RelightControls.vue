<script setup lang="ts">
/** The Relight effect's settings. Layout and presets follow the mockup (artifact 7rAD2Mu5a2S5d34kHU42iy). */
import { computed, onBeforeUnmount, ref } from 'vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import { RELIGHT_MAX_LIGHTS, RELIGHT_SWATCHES, newLightId, type RelightEffect, type RelightLight } from '~/lib/relight/settings'
import { RELIGHT_SETUP_NAMES, applySetup, setupOf, type RelightSetupName } from '~/lib/relight/presets'

const props = withDefaults(defineProps<{
  fx: RelightEffect
  selectedLight: string | null
  depthStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** MoGe-2 surfaces (the photo's normal map) for this layer's photo — a separate, PAID
   *  read from the free local depth `depthStatus` above. 'off' (the kill switch, or no
   *  photo to read yet) shows nothing, same as 'ready'. 'absent' (2026-09-30): the Frame
   *  editor's free peek found nothing cached — the panel offers the "Read shape" button;
   *  no paid read starts until it's clicked. */
  surfacesStatus?: 'idle' | 'loading' | 'ready' | 'error' | 'off' | 'absent'
  /** The price to show while surfaces are being read — null once cached (free) or when
   *  surfacesStatus isn't 'loading'. Surfaces show their price every time, never asked. */
  surfacesPrice?: string | null
  /** The "Read shape" button's own price — shown whenever surfacesStatus is 'absent'. */
  surfacesReadPrice?: string | null
  /** Words for the error line in place of the plain one — set only for a read that is still
   *  running on the provider ("Still reading — try again in a minute"). */
  surfacesNote?: string | null
  /** Finish (stage 3): Nano Banana 2 turns the live preview into a realistic photo. The
   *  button's price text ("~$0.10" locally, "20 credits" hosted). */
  finishPrice?: string | null
  /** A Finish call is running — the button disables and reads "Finishing…". */
  finishBusy?: boolean
  /** False hides the button: the layer can't be finished, or the route is switched off. */
  finishAvailable?: boolean
  /** Shown but not clickable (another edit is running, or Compare is held) — text unchanged. */
  finishBlocked?: boolean
}>(), { surfacesStatus: 'off', surfacesPrice: null, surfacesReadPrice: null, surfacesNote: null, finishPrice: null, finishBusy: false, finishAvailable: false, finishBlocked: false })
const emit = defineEmits<{ update: [patch: Partial<RelightEffect>]; 'select-light': [id: string]; compare: [on: boolean]; 'retry-surfaces': []; 'read-surfaces': []; finish: [] }>()

const active = computed(() => setupOf(props.fx))
const light = computed(() => props.fx.lights.find(l => l.id === props.selectedLight) ?? props.fx.lights[0] ?? null)
const lightIndex = computed(() => (light.value ? props.fx.lights.indexOf(light.value) + 1 : 0))

function pickSetup(name: RelightSetupName) {
  const next = applySetup(props.fx, name)
  emit('update', { keep: next.keep, lights: next.lights })
  if (next.lights[0]) emit('select-light', next.lights[0].id)
}
function addLight() {
  if (props.fx.lights.length >= RELIGHT_MAX_LIGHTS) return
  const l: RelightLight = { id: newLightId(), x: 0.5, y: 0.25, height: 0.35, color: '#f4f7ff', brightness: 1.4, reach: 1, on: true }
  emit('update', { lights: [...props.fx.lights, l] })
  emit('select-light', l.id)
}
function patchLight(p: Partial<RelightLight>) {
  const l = light.value; if (!l) return
  emit('update', { lights: props.fx.lights.map(x => (x.id === l.id ? { ...x, ...p } : x)) })
}
function removeLight() {
  const l = light.value; if (!l || props.fx.lights.length <= 1) return
  const rest = props.fx.lights.filter(x => x.id !== l.id)
  emit('update', { lights: rest })
  if (rest[0]) emit('select-light', rest[0].id)
}
// Compare is a hold. Every way the hold can end releases it — including the pointer being taken
// away (pointercancel / lostpointercapture) and the panel going away mid-hold.
const comparing = ref(false)
function compare(on: boolean) {
  if (comparing.value === on) return
  comparing.value = on
  emit('compare', on)
}
function compareDown(e: PointerEvent) {
  try { (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId) } catch { /* no capture: the other ends still release */ }
  compare(true)
}
onBeforeUnmount(() => compare(false))
const heightWord = (h: number) => (h < 0 ? 'Behind' : h < 0.2 ? 'Low' : h < 0.55 ? 'Mid' : 'High')
</script>

<template>
  <div class="space-y-4 text-[12px]">
    <button v-if="surfacesStatus === 'absent'" data-testid="relight-surfaces-read"
      class="h-7 px-2.5 rounded-[8px] bg-white/10 text-white/80 hover:bg-white/15 hover:text-white cursor-pointer"
      title="Reads this photo's surfaces for more realistic light — once per photo"
      @click="emit('read-surfaces')">Read shape · {{ surfacesReadPrice }}</button>
    <p v-else-if="surfacesStatus === 'loading'" class="text-white/50" data-testid="relight-status-loading" title="Worked out once per photo">
      {{ surfacesPrice ? `Reading shape · ${surfacesPrice}` : 'Reading shape' }}
    </p>
    <p v-else-if="surfacesStatus === 'error'" class="text-red-300/80 flex items-center gap-2" data-testid="relight-status-error" title="Worked out once per photo">
      <span>{{ surfacesNote ?? "Couldn't read this photo's shape" }}</span>
      <button data-testid="relight-surfaces-retry" class="text-white/70 hover:text-white underline underline-offset-2 cursor-pointer" @click="emit('retry-surfaces')">Retry</button>
    </p>
    <p v-else-if="depthStatus === 'loading'" class="text-white/50" data-testid="relight-status-loading">Reading shape…</p>
    <p v-else-if="depthStatus === 'error'" class="text-red-300/80" data-testid="relight-status-error">Couldn't read this photo's shape</p>

    <section class="space-y-2">
      <div class="text-white/40 uppercase tracking-[.04em] text-[11px]">Setups</div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="n in RELIGHT_SETUP_NAMES" :key="n" :data-testid="`relight-setup-${n}`" :aria-pressed="active === n"
          class="h-7 px-2.5 rounded-[8px] cursor-pointer" :class="active === n ? 'bg-white/15 text-white' : 'bg-white/5 text-white/60 hover:text-white'"
          @click="pickSetup(n)">{{ n }}</button>
      </div>
    </section>

    <section class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-white/40 uppercase tracking-[.04em] text-[11px]">Lights</span>
        <button data-testid="relight-compare" title="Hold to see the photo without Relight" class="h-7 px-2.5 rounded-[8px] bg-white/5 text-white/70 hover:text-white cursor-pointer"
          @pointerdown="compareDown" @pointerup="compare(false)" @pointerleave="compare(false)"
          @pointercancel="compare(false)" @lostpointercapture="compare(false)">Compare</button>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="(l, i) in fx.lights" :key="l.id" :data-testid="`relight-light-${i + 1}`"
          class="h-7 px-2.5 rounded-[8px] flex items-center gap-1.5 cursor-pointer" :class="l.id === light?.id ? 'bg-white/15 text-white' : 'bg-white/5 text-white/60'"
          @click="emit('select-light', l.id)">
          <span class="size-2.5 rounded-full" :style="{ background: l.color, opacity: l.on ? 1 : 0.35 }" />Light {{ i + 1 }}
        </button>
        <button data-testid="relight-add-light" title="Add a light (or double-click the photo)" :disabled="fx.lights.length >= RELIGHT_MAX_LIGHTS"
          class="size-7 rounded-[8px] bg-white/5 text-white/70 disabled:opacity-40 cursor-pointer disabled:cursor-default" @click="addLight">+</button>
      </div>
    </section>

    <section v-if="light" class="space-y-2" data-testid="relight-light-panel">
      <div class="flex items-center justify-between">
        <span class="text-white/40 uppercase tracking-[.04em] text-[11px]">Light {{ lightIndex }}</span>
        <div class="flex items-center gap-1">
          <StudioSwitch data-testid="relight-light-on" label="On" :model-value="light.on" @update:model-value="(v: boolean) => patchLight({ on: v })" />
          <button data-testid="relight-remove-light" title="Remove light" :disabled="fx.lights.length <= 1"
            class="size-7 rounded-[8px] hover:bg-white/10 text-white/60 cursor-pointer disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent" @click="removeLight">✕</button>
        </div>
      </div>
      <div class="flex flex-wrap gap-1.5 items-center">
        <button v-for="s in RELIGHT_SWATCHES" :key="s.label" :data-testid="`relight-swatch-${s.label}`" :title="s.label" :aria-label="s.label"
          class="size-5 rounded-full cursor-pointer" :class="light.color === s.color ? 'ring-2 ring-white ring-offset-2 ring-offset-[#151517]' : ''"
          :style="{ background: s.color }" @click="patchLight({ color: s.color })" />
        <label class="size-5 rounded-full overflow-hidden relative cursor-pointer" title="Any colour"
          style="background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red)">
          <input type="color" aria-label="Any colour" class="absolute inset-0 opacity-0 cursor-pointer" :value="light.color"
            @input="patchLight({ color: ($event.target as HTMLInputElement).value })">
        </label>
      </div>
      <StudioSlider data-testid="relight-brightness" label="Brightness" :min="0" :max="4" :step="0.01" :default="1.4" :model-value="light.brightness" @update:model-value="(v: number) => patchLight({ brightness: v })" />
      <StudioSlider data-testid="relight-height" :label="`Height · ${heightWord(light.height)}`" :min="-0.3" :max="1" :step="0.01" :default="0.35" :model-value="light.height" @update:model-value="(v: number) => patchLight({ height: v })" />
      <StudioSlider data-testid="relight-reach" label="Reach" :min="0.1" :max="2" :step="0.01" :default="1" :model-value="light.reach" @update:model-value="(v: number) => patchLight({ reach: v })" />
    </section>

    <section class="space-y-2">
      <div class="text-white/40 uppercase tracking-[.04em] text-[11px]">Photo</div>
      <StudioSlider data-testid="relight-keep" label="Original light" hint="How much of the photo's own lighting stays" :min="0" :max="1" :step="0.01" :default="0.35" :model-value="fx.keep" @update:model-value="(v: number) => emit('update', { keep: v })" />
      <StudioSlider data-testid="relight-depth" label="Depth" hint="How strongly the photo's shape bends the light" :min="0" :max="20" :step="0.1" :default="4" :model-value="fx.depth" @update:model-value="(v: number) => emit('update', { depth: v })" />
      <StudioSlider data-testid="relight-texture" label="Texture" hint="Fine relief from the photo itself: fur, pores, knit" :min="0" :max="8" :step="0.1" :default="2" :model-value="fx.texture" @update:model-value="(v: number) => emit('update', { texture: v })" />
      <StudioSlider data-testid="relight-shine" label="Shine" hint="Glossy highlights" :min="0" :max="1" :step="0.01" :default="0" :model-value="fx.shine" @update:model-value="(v: number) => emit('update', { shine: v })" />
      <StudioSwitch data-testid="relight-shadows" label="Shadows" hint="Short contact shadows: hair on skin, chin on neck, folds" :model-value="fx.shadows" @update:model-value="(v: boolean) => emit('update', { shadows: v })" />
    </section>

    <button v-if="finishAvailable" data-testid="relight-finish" :disabled="finishBusy || finishBlocked"
      class="w-full h-8 px-3 rounded-[8px] bg-white text-black font-medium hover:bg-white/90 cursor-pointer disabled:opacity-60 disabled:cursor-default"
      title="Adds real shadows and bounce light · about 14 s"
      @click="emit('finish')">{{ finishBusy ? 'Finishing…' : (finishPrice ? `Finish · ${finishPrice}` : 'Finish') }}</button>
  </div>
</template>
