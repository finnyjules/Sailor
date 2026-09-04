<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Gem, Pencil } from 'lucide-vue-next'
import { renderStudio, drawToCanvas, studioFramePad } from '~/lib/geoshape/render'
import { studioDocFromPersisted } from '~/lib/geoshape/studio'
import { registerStudioBaker, unregisterStudioBaker } from '~/lib/studio/cascade'
import { registerStudioFrameSource, unregisterStudioFrameSource } from '~/lib/studio/frameSource'
import { makeShapeFrameSource } from '~/lib/geoshape/frameSource'
import StudioRenderButton from '~/components/vue-canvas/StudioRenderButton.vue'

// Shape Studio — a frontend-only config node (no backend class_type, never
// executes). Modeled on GradientStudioNode.vue/TextureStudioNode.vue: the
// engine (lib/geoshape) is a plain 2D-vector "clone and arrange" pipeline —
// `renderShapes` folds the config into paintable VectorShape[], and
// `drawToCanvas` rasterizes them onto a 2D canvas context. The card still
// shows a still (the last export, or the last Render's bake) rather than a
// live per-frame preview, matching every other studio card's footer-render
// pattern. It registers a studio-cascade baker: `bakeOutput()` renders the
// persisted config at the persisted canvas size onto a throwaway offscreen
// <canvas> and reads back a PNG — the same rasterize-then-toBlob pattern
// ShapeStudioSurface.vue's own `rasterizePng()` uses for its "As image"
// export, so the node bake and the in-studio export never drift. That baker
// powers the footer StudioRenderButton and pre-run baking. "Edit" opens the
// full ShapeStudioSurface, which writes config back to
// node.data.properties.sailor_shapeStudio.
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

// Last exported filename, learned live from this node's own output event —
// not persisted, so it resets on reload (acceptable v1: "if present").
const lastExportedFile = ref<string | null>(null)
// A direct object-URL of the most recent in-card bake (footer Render), shown for
// instant feedback: the cascade uploads+publishes to the DOWNSTREAM image node,
// so it never round-trips a filename back to this card. Preferred over the
// exported /view URL when present; revoked before it's replaced.
const bakedThumb = ref<string | null>(null)
const thumbUrl = computed(() =>
  bakedThumb.value
    ?? (lastExportedFile.value
      ? `/view?${new URLSearchParams({ filename: lastExportedFile.value, type: 'input' })}`
      : null),
)

function onOutput(e: Event) {
  const detail = (e as CustomEvent).detail
  if (!detail || String(detail.sourceNodeId) !== String(props.id)) return
  const filename = detail.widgetOverrides?.image
  if (filename) lastExportedFile.value = String(filename)
}

// Headless full-res bake for the render cascade (generative — no input).
// Renders the persisted config onto a throwaway offscreen 2D canvas at the
// persisted output dims and reads back one PNG — mirrors
// ShapeStudioSurface.vue's `rasterizePng()` export path exactly, so the node
// bake and the in-studio "As image" export never drift. Also refreshes the
// card's own still for instant feedback (see bakedThumb).
async function bakeOutput(): Promise<Blob | null> {
  const blob = props.data?.properties?.sailor_shapeStudio as
    { doc?: unknown; config?: unknown; canvasW?: number; canvasH?: number } | undefined
  const studioDoc = studioDocFromPersisted(blob)
  const w = typeof blob?.canvasW === 'number' ? blob.canvasW : 1024
  const h = typeof blob?.canvasH === 'number' ? blob.canvasH : 1024
  try {
    const shapes = await renderStudio(studioDoc)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w))
    canvas.height = Math.max(1, Math.round(h))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    drawToCanvas(shapes, ctx, canvas.width, canvas.height, studioFramePad(studioDoc))
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!out) return null
    if (bakedThumb.value) URL.revokeObjectURL(bakedThumb.value)
    bakedThumb.value = URL.createObjectURL(out)
    return out
  } catch (e) {
    console.error('[shape-studio] bake failed', e)
    return null
  }
}

// Live frame source so a direct Shape→Frame wire paints immediately (frameResolve
// prefers a live source over a baked file), matching Gradient/Vector/Space/Scene3D.
// Shape Studio is a still, so this renders the persisted config once per pull —
// same renderStudio→drawToCanvas path as bakeOutput, but reusing one owned canvas
// (the StudioFrameSource contract: the returned surface is valid only until the
// next getFrame call, so consumers copy it out before pulling again).
let frameCanvas: HTMLCanvasElement | null = null
async function renderFrameSurface(w: number, h: number): Promise<TexImageSource> {
  const blob = props.data?.properties?.sailor_shapeStudio as
    { doc?: unknown; config?: unknown; canvasW?: number; canvasH?: number } | undefined
  const studioDoc = studioDocFromPersisted(blob)
  const shapes = await renderStudio(studioDoc)
  if (!frameCanvas) frameCanvas = document.createElement('canvas')
  frameCanvas.width = Math.max(1, Math.round(w))
  frameCanvas.height = Math.max(1, Math.round(h))
  const ctx = frameCanvas.getContext('2d')
  if (!ctx) return frameCanvas
  ctx.clearRect(0, 0, frameCanvas.width, frameCanvas.height)
  drawToCanvas(shapes, ctx, frameCanvas.width, frameCanvas.height, studioFramePad(studioDoc))
  return frameCanvas
}

onMounted(() => {
  window.addEventListener('sailor:shapeStudioOutput', onOutput)
  registerStudioBaker(props.id, bakeOutput)
  registerStudioFrameSource(props.id, makeShapeFrameSource({
    getPersisted: () => props.data?.properties?.sailor_shapeStudio,
    render: renderFrameSurface,
  }))
})
onBeforeUnmount(() => {
  window.removeEventListener('sailor:shapeStudioOutput', onOutput)
  unregisterStudioBaker(props.id)
  unregisterStudioFrameSource(props.id)
  if (bakedThumb.value) URL.revokeObjectURL(bakedThumb.value)
})

function openEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openShapeStudio', { detail: { nodeId: props.id } }))
}

// Index of the optional `vars` input a Collection's VARS output wires into.
// Rendering its port (below) is what lets that edge anchor and survive reload.
const varsInputIndex = computed(() =>
  ((props.data?.inputs as { name?: string }[] | undefined) ?? []).findIndex(i => i?.name === 'vars'))
</script>

<template>
  <!-- Ports live outside the card: the card clips its own content
       (overflow-hidden), which would otherwise cut the dots and their hit
       areas in half. As siblings they also tuck in behind it. -->
  <div class="studio-node relative w-fit">
    <!-- Variables input: a Collection's VARS output wires here. Rendering this
         port lets the VARS edge anchor so it survives reload. -->
    <VueCanvasNodePort
      v-if="varsInputIndex >= 0"
      :id="`input-${varsInputIndex}`" type="target" side="left" :index="0"
      data-type="VARS" label="variables"
    />

    <!-- Output handle: anchors the provenance edge to a generated Image node. -->
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
      <Gem class="h-3.5 w-3.5 text-white/70" />
      <span class="text-xs font-medium text-white/80">Shape Studio</span>
    </div>

    <!-- Last exported thumbnail (no live preview — see note above) -->
    <div class="flex aspect-video items-center justify-center bg-neutral-950">
      <img v-if="thumbUrl" :src="thumbUrl" class="block max-h-full max-w-full object-contain" alt="" />
      <span v-else class="text-[10px] text-white/30">No export yet</span>
    </div>

    <!-- Edit + Render -->
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
