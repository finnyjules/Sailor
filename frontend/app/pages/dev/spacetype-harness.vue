<template>
  <div style="margin:0;background:#000">
    <canvas ref="canvas" :width="W" :height="H" style="display:block" />
    <div style="position:fixed;top:6px;left:8px;font:11px monospace;color:#666">spacetype harness · {{ effectId }}</div>
    <!-- The real effect gallery, so its two tabs can be looked at without opening the studio.
         Picking an entry reloads the harness on it. -->
    <button type="button" data-open-gallery style="position:fixed;top:6px;right:10px;font:11px monospace;color:#999;background:#222;border:0;border-radius:4px;padding:4px 8px;cursor:pointer" @click="showGallery = true">effect gallery</button>
    <SpaceTypeEffectGalleryModal v-if="showGallery" :selected-id="effectId" @close="showGallery = false" @select="onPickEffect" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import '@fontsource/anton'
import '@fontsource/inter'
import { SpaceTypeEngine } from '~/lib/spacetype/engine'
import { getEffect } from '~/lib/spacetype/effects'
import { ensureBoostFont } from '~/lib/spacetype/effects/boost'
import { defaultsFromControls, type Params } from '~/lib/spacetype/effect'
import { separatorFromParams } from '~/lib/spacetype/separator'
import type { TextTextureOptions } from '~/lib/spacetype/textTexture'
import SpaceTypeEffectGalleryModal from '~/components/vue-canvas/SpaceTypeEffectGalleryModal.vue'

definePageMeta({ layout: false })

// Standalone visual harness for Space Type effects (mirrors the shaderfx-harness
// pattern). Renders an effect into a canvas with a default config, and exposes
// window.__echo(partialParams) to tweak params live + screenshot. No backend.

const canvas = ref<HTMLCanvasElement | null>(null)
const W = 900, H = 650
// Effect id from ?effect= (so the harness can preview any effect without editing), default 'echo'.
const effectId = ref(
  (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('effect')) || 'echo',
)
let engine: SpaceTypeEngine | null = null
let raf = 0
let frame = 0
let params: Params = {}
let animate = false
const showGallery = ref(false)
function onPickEffect(id: string) { window.location.search = `?effect=${encodeURIComponent(id)}` }

function texOpts(): TextTextureOptions {
  // Split on newlines into a multi-row atlas (matches SpaceTypeSurface), so effects that
  // cycle through multiple text lines can be exercised in the harness.
  const lines = String(params.text ?? 'ECHO').split('\n').map(t => t.trim()).filter(Boolean)
  // Mirror SpaceTypeSurface: supersample the slit-scan atlas (it fills the frame → magnifies text).
  const atlasSS = effectId.value === 'slitscan' ? 3 : 1
  return {
    label: lines[0] ?? 'ECHO',
    labels: lines.length ? lines : ['ECHO'],
    fontFamily: String(params.font ?? 'Anton'),
    fontWeight: Number(params.typeWeight ?? 400),
    axes: { wght: Number(params.typeWeight ?? 400) },
    typeColor: '#ffffff',
    fontSizePx: Number(params.typeYScale ?? params.typeHeight ?? 200) * atlasSS,
    heightPx: 256 * atlasSS,
    scaleX: 1,
    tracking: Number(params.tracking ?? 0),
    strokeColor: '#000000',
    strokeWidth: Number(params.typeStroke ?? 0),
    // Same resolver as texOptsFromState / the embed's buildTexOpts, so the harness shows the separator too.
    separator: separatorFromParams(effectId.value, params),
  }
}

function rebuild() { frame = 0; engine?.build(params, texOpts()) }

function loop() {
  if (!animate) return
  engine?.renderFrame(frame++, params)
  raf = requestAnimationFrame(loop)
}

async function apply(partial: Record<string, unknown> = {}, opts: { animate?: boolean; frame?: number; bg?: string } = {}) {
  if (opts.bg) engine?.setBackground(false, opts.bg)
  Object.assign(params, partial)
  animate = !!opts.animate
  // boost builds glyphs from vector outlines — preload like SpaceTypeSurface does.
  if (effectId.value === 'boost') { try { await ensureBoostFont(String(params.font)) } catch { /* noop */ } }
  rebuild()
  if (animate) { if (!raf) loop() }
  else {
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    engine?.renderFrame(typeof opts.frame === 'number' ? opts.frame : 0, params)
  }
  return { ok: true, params: { ...params } }
}

onMounted(async () => {
  if (!canvas.value) return
  await (document as any).fonts?.ready
  const eff = getEffect(effectId.value)
  params = defaultsFromControls(eff.controls)
  // Use the effect's own defaults; only swap in the reference string.
  Object.assign(params, { text: 'THE 1795' })
  engine = new SpaceTypeEngine(canvas.value, {
    effect: eff, width: W, height: H, fps: 30, loopDuration: 2,
    alpha: false, bgColor: '#000000', projection: 'perspective',
  })
  rebuild()
  engine.renderFrame(0, params)
  ;(window as any).__echo = apply
  ;(window as any).__engine = engine
  ;(window as any).__echoReady = true
})

onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf); engine?.dispose(); engine = null })
</script>
