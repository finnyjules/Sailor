<script setup lang="ts">
/** The Relight effect's settings. Layout and presets follow the mockup (artifact 7rAD2Mu5a2S5d34kHU42iy). */
import { onBeforeUnmount, ref } from 'vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import type { RelightEffect } from '~/lib/relight/settings'
import { RELIGHT_SETUP_NAMES, type RelightSetupName } from '~/lib/relight/presets'

/** One of the Frame's light layers, as a chip (light layers stage 2: Relight's lights ARE the
 *  Frame's lights; they are edited in the light inspector, not here). */
export interface RelightLightChip { id: string; name: string; color: string; visible: boolean }

withDefaults(defineProps<{
  fx: RelightEffect
  /** The Frame's light layers, in stack order. */
  lights?: readonly RelightLightChip[]
  /** The selected light layer's id, if a light is selected. */
  selectedLight?: string | null
  /** The Setup the Frame still matches around this photo (lights + Original light), or null. */
  activeSetup?: RelightSetupName | null
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
   *  button's price text ("~$0.08" locally, "16 credits" hosted). */
  finishPrice?: string | null
  /** A Finish call is running — the button disables and reads "Finishing…". */
  finishBusy?: boolean
  /** False hides the button: the layer can't be finished, or the route is switched off. */
  finishAvailable?: boolean
  /** Shown but not clickable (another edit is running, or Compare is held) — text unchanged. */
  finishBlocked?: boolean
  /** A Finish call is running on this layer: every control above the button is inert, so the
   *  settings can't drift from the guide that was sent. */
  locked?: boolean
}>(), { lights: () => [], selectedLight: null, activeSetup: null, surfacesStatus: 'off', surfacesPrice: null, surfacesReadPrice: null, surfacesNote: null, finishPrice: null, finishBusy: false, finishAvailable: false, finishBlocked: false, locked: false })
const emit = defineEmits<{ update: [patch: Partial<RelightEffect>]; setup: [name: RelightSetupName]; 'select-light': [id: string]; compare: [on: boolean]; 'retry-surfaces': []; 'read-surfaces': []; finish: [] }>()

// Compare is a hold. Every way the hold can end releases it — including the pointer being taken
// away (pointercancel / lostpointercapture), the panel going away mid-hold, and — the fallback
// when the button never hears the release — any pointerup in the window or the window losing focus.
const comparing = ref(false)
const release = () => compare(false)
function compare(on: boolean) {
  if (comparing.value === on) return
  comparing.value = on
  if (typeof window !== 'undefined') {
    if (on) { window.addEventListener('pointerup', release, true); window.addEventListener('blur', release) }
    else { window.removeEventListener('pointerup', release, true); window.removeEventListener('blur', release) }
  }
  emit('compare', on)
}
function compareDown(e: PointerEvent) {
  try { (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId) } catch { /* no capture: the other ends still release */ }
  compare(true)
}
onBeforeUnmount(() => compare(false))
</script>

<template>
  <div class="space-y-4 text-[12px]">
    <div data-testid="relight-controls-body" class="space-y-4" :class="locked ? 'opacity-50 pointer-events-none select-none' : ''"
      :inert="locked || undefined" :aria-disabled="locked || undefined">
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
        <button v-for="n in RELIGHT_SETUP_NAMES" :key="n" :data-testid="`relight-setup-${n}`" :aria-pressed="activeSetup === n"
          class="h-7 px-2.5 rounded-[8px] cursor-pointer" :class="activeSetup === n ? 'bg-white/15 text-white' : 'bg-white/5 text-white/60 hover:text-white'"
          @click="emit('setup', n)">{{ n }}</button>
      </div>
    </section>

    <section class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-white/40 uppercase tracking-[.04em] text-[11px]">Lights</span>
        <button data-testid="relight-compare" title="Hold to see the original photo" class="h-7 px-2.5 rounded-[8px] bg-white/5 text-white/70 hover:text-white cursor-pointer"
          @pointerdown="compareDown" @pointerup="compare(false)" @pointerleave="compare(false)"
          @pointercancel="compare(false)" @lostpointercapture="compare(false)">Compare</button>
      </div>
      <div v-if="lights.length" class="flex flex-wrap gap-1.5">
        <button v-for="(l, i) in lights" :key="l.id" :data-testid="`relight-light-${i + 1}`" :data-light-id="l.id"
          :aria-pressed="l.id === selectedLight" title="Edit this light"
          class="h-7 px-2.5 rounded-[8px] flex items-center gap-1.5 cursor-pointer" :class="l.id === selectedLight ? 'bg-white/15 text-white' : 'bg-white/5 text-white/60 hover:text-white'"
          @click="emit('select-light', l.id)">
          <span class="size-2.5 rounded-full" :style="{ background: l.color, opacity: l.visible ? 1 : 0.35 }" />{{ l.name }}
        </button>
      </div>
    </section>

    <section class="space-y-2">
      <div class="text-white/40 uppercase tracking-[.04em] text-[11px]">Photo</div>
      <StudioSlider data-testid="relight-keep" label="Original light" hint="How much of the photo's own lighting stays" :min="0" :max="1" :step="0.01" :default="0.35" :model-value="fx.keep" @update:model-value="(v: number) => emit('update', { keep: v })" />
      <StudioSlider data-testid="relight-depth" label="Depth" hint="How strongly the photo's shape bends the light" :min="0" :max="20" :step="0.1" :default="4" :model-value="fx.depth" @update:model-value="(v: number) => emit('update', { depth: v })" />
      <StudioSlider data-testid="relight-texture" label="Texture" hint="Fine relief from the photo itself: fur, pores, knit" :min="0" :max="8" :step="0.1" :default="2" :model-value="fx.texture" @update:model-value="(v: number) => emit('update', { texture: v })" />
      <StudioSlider data-testid="relight-shine" label="Shine" hint="Glossy highlights" :min="0" :max="1" :step="0.01" :default="0" :model-value="fx.shine" @update:model-value="(v: number) => emit('update', { shine: v })" />
      <StudioSwitch data-testid="relight-shadows" label="Shadows" hint="Short contact shadows: hair on skin, chin on neck, folds" :model-value="fx.shadows" @update:model-value="(v: boolean) => emit('update', { shadows: v })" />
    </section>
    </div>

    <button v-if="finishAvailable" data-testid="relight-finish" :disabled="finishBusy || finishBlocked"
      class="w-full h-8 px-3 rounded-[8px] bg-white text-black font-medium hover:bg-white/90 cursor-pointer disabled:opacity-60 disabled:cursor-default"
      title="Adds real shadows and bounce light · about 20 s"
      @click="emit('finish')">{{ finishBusy ? 'Finishing…' : (finishPrice ? `Finish · ${finishPrice}` : 'Finish') }}</button>
  </div>
</template>
