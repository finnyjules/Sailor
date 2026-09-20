<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Layers, Pencil } from 'lucide-vue-next'
import { textureFx } from '~/lib/texturefx/renderer'
import { preloadStylize, stylizeTile } from '~/lib/texturefx/stylize'
import { textureDefaults } from '~/lib/texturefx/controls'
import { loadRaster, getRaster } from '~/lib/texturefx/raster'
import { bakeSheetBlob } from '~/lib/texturefx/bake'
import { drawSheet, fitLetterbox, isSheetFramed, sheetFromParams } from '~/lib/texturefx/sheet'
import type { Params } from '~/lib/spacetype/effect'
import { registerStudioBaker, unregisterStudioBaker } from '~/lib/studio/cascade'
import StudioRenderButton from '~/components/vue-canvas/StudioRenderButton.vue'

// Texture Studio — a frontend-only config node (no backend class_type, never
// executes). The card shows a live seamless-tile preview from the saved params;
// "Edit" opens the full TextureStudioSurface bound to this node, which writes
// its params back to node.data.properties.sailor_textureStudio.
const props = defineProps<{
  id: string
  data: {
    nodeType: string
    title?: string
    mode?: number
    properties?: Record<string, any>
    studioBusy?: boolean
    inputs?: { name?: string }[]
  }
}>()

const PREVIEW_W = 220
const PREVIEW_H = 148 // ~3:2

const params = computed<Params>(() => {
  // Merge over defaults so nodes saved before newer keys existed (e.g. mode/
  // tileFamily) still render — symmetric with the surface's loadParams().
  const saved = props.data?.properties?.sailor_textureStudio as Params | undefined
  return saved ? { ...textureDefaults(), ...saved } : textureDefaults()
})

const canvasEl = ref<HTMLCanvasElement | null>(null)
const glError = ref<string | null>(null)

function renderFrame() {
  const canvas = canvasEl.value
  if (!canvas) return
  if (canvas.width !== PREVIEW_W || canvas.height !== PREVIEW_H) {
    canvas.width = PREVIEW_W
    canvas.height = PREVIEW_H
  }
  try {
    const p = params.value
    const s = sheetFromParams(p)
    const framed = isSheetFramed(p)
    // On the Tile preset the output is a material sample, so fill the card edge to
    // edge as it always has. Once a sheet is chosen the card shows that sheet's
    // shape, letterboxed — otherwise a 9:16 pattern would look 3:2 on the canvas.
    const box = framed
      ? fitLetterbox(s, PREVIEW_W, PREVIEW_H)
      : { w: PREVIEW_W, h: PREVIEW_H, x: 0, y: 0 }
    // Unframed (Tile preset): the card is a material swatch — a window onto the
    // infinite field at the pre-sheet density, i.e. a PREVIEW_H-sized tile
    // repeat-filling the 3:2 card, exactly as ctx.createPattern did before the sheet
    // existed. Framed: the card shows the sheet's own aspect and density, letterboxed.
    const view = framed ? s : { w: PREVIEW_W, h: PREVIEW_H, tile: PREVIEW_H }
    // Render the seamless tile SQUARE (so cells stay square / undistorted), then
    // repeat-fill. Drawing a square tile straight into a 3:2 canvas stretched the
    // pattern horizontally.
    const TILE = Math.max(32, Math.min(256, Math.round(view.tile * (box.w / view.w))))
    const base = textureFx.render(p, TILE, TILE, 0)
    const out = stylizeTile(base, p, TILE, TILE)
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H)
    ctx.save()
    try {
      ctx.beginPath()
      ctx.rect(box.x, box.y, box.w, box.h)
      ctx.clip()
      ctx.translate(box.x, box.y)
      drawSheet(ctx, out, view, box.w, box.h)
    } finally { ctx.restore() }
    glError.value = null
  }
  catch (e: any) {
    glError.value = String(e?.message ?? e)
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
watch(params, () => {
  if (timer) clearTimeout(timer)
  const p = params.value
  if (String(p.mode) === 'raster' && p.rasterSrc && !getRaster(String(p.rasterSrc))) {
    loadRaster(String(p.rasterSrc)).then(renderFrame).catch(() => {})
  }
  timer = setTimeout(renderFrame, 60)
}, { deep: true })

// Headless full-res sheet for the render cascade (generative — no input). Same bake
// as the studio's exportBlob, so the cascade and the studio agree.
async function bakeOutput(): Promise<Blob | null> {
  await preloadStylize().catch(() => {})
  try { return await bakeSheetBlob(params.value) }
  catch (e) { console.error('[texture] headless bake failed', e); return null }
}

onMounted(() => {
  renderFrame()
  // Stylize effects load async; re-render the thumbnail once they're ready.
  preloadStylize().then(renderFrame).catch(() => {})
  // Restore a saved raster image so the card preview renders correctly on load.
  const p = params.value
  if (String(p.mode) === 'raster' && p.rasterSrc && !getRaster(String(p.rasterSrc))) {
    loadRaster(String(p.rasterSrc)).then(renderFrame).catch(() => {})
  }
  registerStudioBaker(props.id, bakeOutput)
})
onBeforeUnmount(() => { if (timer) clearTimeout(timer); unregisterStudioBaker(props.id) })

function openEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openTextureStudio', { detail: { nodeId: props.id } }))
}

// Index of the optional `vars` input a Collection's VARS output wires into.
// Rendering its port (below) is what lets that edge anchor and survive reload.
const varsInputIndex = computed(() =>
  ((props.data?.inputs as { name?: string }[] | undefined) ?? []).findIndex(i => i?.name === 'vars'))
</script>

<template>
  <!-- Ports live OUTSIDE the card, exactly as GradientStudioNode does. The card is
       `overflow-hidden`, so ports rendered inside it get clipped in half — which is why
       this node's dots looked like they were sitting inside the body while every other
       node's tuck against the edge. As siblings they also share the shared NodePort
       treatment (hit area, hover label, type colour) instead of a bare vue-flow Handle. -->
  <div class="studio-node relative w-fit">
    <!-- Variables input: a Collection's VARS output wires here. Rendering this port
         lets the VARS edge anchor so it survives reload (fixes edge-lost-on-restart). -->
    <VueCanvasNodePort
      v-if="varsInputIndex >= 0"
      :id="`input-${varsInputIndex}`" type="target" side="left" :index="0"
      data-type="VARS" label="variables"
    />

    <!-- Output: anchors the provenance edge to a generated Image node. -->
    <VueCanvasNodePort
      id="output-0" type="source" side="right" :index="0"
      data-type="IMAGE" label="image"
    />

  <div
    class="relative z-10 w-[220px] overflow-hidden rounded-xl border border-white/10 bg-neutral-900 text-white shadow-lg"
    @dblclick.stop="openEditor"
  >

    <!-- Header -->
    <div class="flex items-center gap-2 border-b border-white/10 px-3 py-2">
      <Layers class="h-3.5 w-3.5 text-white/70" />
      <span class="text-xs font-medium text-white/80">Pattern Studio</span>
    </div>

    <!-- Live seamless preview -->
    <div class="flex items-center justify-center bg-neutral-950">
      <canvas ref="canvasEl" class="block w-full" :style="{ height: PREVIEW_H + 'px' }" />
    </div>
    <div v-if="glError" class="truncate px-3 py-1 text-[10px] text-red-300/90" :title="glError">{{ glError }}</div>

    <!-- Edit -->
    <div class="border-t border-white/10 p-2 flex items-center gap-1.5">
      <button
        class="flex flex-1 items-center justify-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-[11px] text-white/80 transition hover:bg-white/20"
        @click.stop="openEditor"
      >
        <Pencil class="h-3 w-3" /> Edit
      </button>
      <StudioRenderButton class="flex-1" :node-id="id" :busy="!!data?.studioBusy" />
    </div>
  </div>
  </div>
</template>
