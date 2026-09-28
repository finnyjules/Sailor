<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Sparkles } from 'lucide-vue-next'
import { gradientFx } from '~/lib/gradientfx/renderer'
import { defaultConfig } from '~/lib/gradientfx/randomize'
import { aspectRatio, LAYOUT_LABELS, type GradientConfig } from '~/lib/gradientfx/types'
import { registerStudioBaker, unregisterStudioBaker } from '~/lib/studio/cascade'
import { registerStudioFrameSource, unregisterStudioFrameSource } from '~/lib/studio/frameSource'
import { makeGradientFrameSource } from '~/lib/gradientfx/frameSource'
import { useCanvasCardPreviewLoop } from '~/composables/useCanvasCardPreviewLoop'
import { useNodeGlass } from '~/composables/useCanvasGlass'
import { isStudioControl } from '~/lib/canvas/studioDblclick'
import StudioRenderButton from '~/components/vue-canvas/StudioRenderButton.vue'
import NodeOpenBar from '~/components/vue-canvas/surfaces/NodeOpenBar.vue'

// Gradient Studio — a frontend-only config node (no backend class_type, never
// executes). The card shows a live preview from the saved config; "Edit" opens
// the full GradientStudioSurface bound to this node, which writes its config
// back to node.data.properties.sailor_gradientStudio.
const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    nodeType: string
    title?: string
    mode?: number
    properties?: Record<string, any>
    studioBusy?: boolean
    inputs?: { name?: string }[]
  }
}>()

const glass = useNodeGlass(() => props.id)

const PREVIEW_W = 220
// Backing-store ceiling. The card animates via rAF when flow speed > 0, so the
// buffer we render every frame is capped here — 2× the 220px card covers retina
// (dpr 2) with headroom, without letting an unexpectedly wide card blow up cost.
const PREVIEW_MAX_W = 640

const config = computed<GradientConfig>(
  () => (props.data?.properties?.sailor_gradientStudio as GradientConfig) ?? defaultConfig('#default0'),
)

const previewH = computed(() => Math.round(PREVIEW_W / aspectRatio(config.value.canvas.aspect)))
const canvasEl = ref<HTMLCanvasElement | null>(null)
const glError = ref<string | null>(null)
const animated = computed(() => {
  if ((config.value.motion?.tracks?.length ?? 0) > 0) return true
  const fl = config.value.flow
  const flowAnim = (fl?.speed ?? 0) > 0 && (fl?.intensity ?? 0) > 0
  const meshAnim = config.value.canvas.layout === 'mesh' && (config.value.layers[0]?.mesh?.drift ?? 0) > 0
  return flowAnim || meshAnim
})

// IntersectionObserver + hover listeners for the shared gated/throttled preview loop.
const rootEl = ref<HTMLElement | null>(null)

// Size the backing store to the card's on-screen box × the display's pixel
// density (dpr), so 1 render pixel maps to 1 physical pixel — crisp at any card
// width and on retina, instead of upscaling a fixed 220px buffer. CSS size stays
// driven by layout (canvas is w-full); we only set the backing store here.
function previewDims() {
  const ar = aspectRatio(config.value.canvas.aspect) || 1
  const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 2)
  const cssW = Math.max(1, Math.round(canvasEl.value?.clientWidth || PREVIEW_W))
  const w = Math.min(Math.round(cssW * dpr), PREVIEW_MAX_W)
  const h = Math.max(1, Math.round(w / ar))
  return { w, h }
}

function renderFrame(t: number) {
  const canvas = canvasEl.value
  if (!canvas) return
  const { w, h } = previewDims()
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
  try {
    const out = gradientFx.render(config.value, w, h, t)
    canvas.getContext('2d')!.drawImage(out, 0, 0)
    glError.value = null
  } catch (e: any) {
    glError.value = String(e?.message ?? e)
  }
}

/** One-shot still (t=0) — the static preview and the paused/hover-leave poster. */
function renderStill() { renderFrame(0) }

// Shared gated + fps-throttled preview loop. Pauses off-screen / tab-hidden / behind a
// fullscreen studio modal / when un-hovered; throttles to 30fps.
const preview = useCanvasCardPreviewLoop({
  rootEl,
  active: () => animated.value,
  fps: () => 30,
  onFrame: ({ t }) => { const dur = Math.max(0.1, config.value.motion?.duration ?? 4); renderFrame(t % dur) },
  onIdle: renderStill,
})

// Headless full-res bake for the render cascade (generative — no input).
const BAKE_W = 1536
async function bakeOutput(): Promise<Blob | null> {
  const ar = aspectRatio(config.value.canvas.aspect) || 1
  return await gradientFx.renderToBlob(config.value, BAKE_W, Math.max(1, Math.round(BAKE_W / ar)), 0)
}

onMounted(() => {
  renderStill(); registerStudioBaker(props.id, bakeOutput)
  registerStudioFrameSource(props.id, makeGradientFrameSource({
    getConfig: () => config.value,
    render: (cfg, w, h, time) => gradientFx.render(cfg, w, h, time),
  }))
})
onBeforeUnmount(() => {
  unregisterStudioBaker(props.id)
  unregisterStudioFrameSource(props.id)
})

// Re-render when the saved config changes (editor writes back live). Debounced.
// While the loop is actively animating it picks up the new config next tick; otherwise
// (paused/not hovered/static) repaint the still poster.
let timer: ReturnType<typeof setTimeout> | null = null
watch(config, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { if (animated.value && preview.gateOk()) return; renderStill() }, 60)
}, { deep: true })

function openEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openGradientStudio', { detail: { nodeId: props.id } }))
}

// Index of the optional `vars` input a Collection's VARS output wires into.
// Rendering its Handle (below) is what lets that edge anchor and survive reload.
const varsInputIndex = computed(() =>
  ((props.data?.inputs as { name?: string }[] | undefined) ?? []).findIndex(i => i?.name === 'vars'))
</script>

<template>
  <!-- Ports live outside the card, as its siblings, so they tuck in behind
       the glass shell instead of sitting inside its body. -->
  <div ref="rootEl" class="studio-node relative w-fit">
    <!-- Variables input: a Collection's VARS output wires here. Rendering this
         port lets the VARS edge anchor so it survives reload. -->
    <VueCanvasNodePort
      v-if="varsInputIndex >= 0"
      :id="`input-${varsInputIndex}`" type="target" side="left" :index="0"
      data-type="VARS" label="variables"
    />

    <!-- Output handle: anchors the provenance edge to a generated Image/Video node. -->
    <VueCanvasNodePort
      id="output-0" type="source" side="right" :index="0"
      data-type="IMAGE" label="image"
    />

  <div
    class="gradient-studio-card node-shell relative z-10 w-[240px]"
    :data-glass-blur="glass || undefined"
    :data-selected="selected || undefined"
    @dblclick.stop="(e) => { if (!isStudioControl(e)) openEditor() }"
  >
    <div class="node-shell__head">
      <Sparkles class="node-shell__icon" />
      <span class="node-shell__title">Gradient Studio</span>
    </div>
    <div class="node-shell__body">
      <div class="node-well node-openbar-host">
        <canvas ref="canvasEl" class="block w-full" :style="{ height: previewH + 'px' }" />
        <NodeOpenBar :meta="LAYOUT_LABELS[config.canvas.layout] ?? config.canvas.layout">
          <button type="button" class="node-btn nopan nodrag" @click.stop="openEditor">Open</button>
        </NodeOpenBar>
      </div>
      <div v-if="glError" class="px-3 py-1 text-[10px] text-red-300/90 truncate" :title="glError">{{ glError }}</div>
    </div>
    <div class="node-shell__foot justify-end">
      <StudioRenderButton :node-id="id" :busy="!!data?.studioBusy" />
    </div>
  </div>
  </div>
</template>
