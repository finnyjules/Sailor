<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'

/**
 * Frame and Timeline: the artwork in a thin frame of light glass, tinted by the artwork itself.
 *
 * The tint is a tiny copy of the artwork with the blur baked in (`ctx.filter`), drawn when the
 * artwork changes (`capture`). Copying one canvas into another stays on the GPU — no pixel
 * read-back — and nothing on screen carries a CSS blur, so a pan costs what a plain picture does.
 */
const props = defineProps<{ name: string; size?: string; artwork?: string; selected?: boolean }>()

// At 64px the tint is drawn ~8× smaller than it shows, so 3px here reads as ~28px on screen.
const TINT_EDGE = 64
const TINT_FILTER = 'blur(3px) saturate(1.6) brightness(1.1)'

const tintEl = ref<HTMLCanvasElement | null>(null)
// Browsers without canvas filters get the CSS blur instead (slower on pan, same look).
const cssBlur = ref(false)
let raf = 0
let pending: HTMLCanvasElement | HTMLImageElement | null = null

function drawTint() {
  raf = 0
  const src = pending
  pending = null
  const cv = tintEl.value
  if (!cv || !src) return
  const sw = src instanceof HTMLImageElement ? src.naturalWidth : src.width
  const sh = src instanceof HTMLImageElement ? src.naturalHeight : src.height
  if (!sw || !sh) return
  const k = TINT_EDGE / Math.max(sw, sh)
  const w = Math.max(1, Math.round(sw * k))
  const h = Math.max(1, Math.round(sh * k))
  if (cv.width !== w) cv.width = w
  if (cv.height !== h) cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) return
  cssBlur.value = !('filter' in ctx)
  ctx.clearRect(0, 0, w, h)
  if (!cssBlur.value) ctx.filter = TINT_FILTER
  ctx.drawImage(src, 0, 0, w, h)
  if (!cssBlur.value) ctx.filter = 'none'
}

/** Copy `src` into the glass tint. Coalesced to one draw per frame. Call it when the artwork
 *  changes — never once per animation frame. */
function capture(src: HTMLCanvasElement | HTMLImageElement) {
  pending = src
  if (!raf) raf = requestAnimationFrame(drawTint)
}

watch(() => props.artwork, (url) => {
  if (!url) return
  const im = new Image()
  im.onload = () => { if (props.artwork === url) capture(im) }
  im.src = url
}, { immediate: true })

onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf) })

defineExpose({ capture })
</script>

<template>
  <div class="print-surface" :data-selected="selected || undefined">
    <div class="print-surface__label">
      <span class="print-surface__name">{{ name }}</span>
      <slot name="size"><span v-if="size" class="print-surface__size">{{ size }}</span></slot>
    </div>
    <div class="print-surface__frame">
      <slot name="ports" />
      <div class="print-surface__glass node-openbar-host" :data-selected="selected || undefined">
        <div class="print-surface__glow" :class="{ 'print-surface__glow--css': cssBlur }" aria-hidden="true"><canvas ref="tintEl" /></div>
        <div class="print-surface__art"><slot><img v-if="artwork" :src="artwork" alt="" class="block w-full"></slot></div>
        <slot name="openbar" />
      </div>
      <slot name="overlay" />
    </div>
    <slot name="below" />
  </div>
</template>
