<script setup lang="ts">
/**
 * Vector Type — the canvas card. A frontend-only config node (no backend
 * class_type, never executes).
 *
 * It carries a LIVE preview rather than Shape Studio's last-export still,
 * because it can afford one: Vector Type is `f(cfg, t) -> paths` on a 2D
 * context, with no WebGL context and no engine to keep alive. That same
 * statelessness is why the frame source here is the easy Gradient case rather
 * than Scene3D's rebake registry.
 *
 * The loop uses `schedule()`, not a bare rAF: rAF is throttled to ZERO in a
 * hidden tab (a headless capture's normal state), so a pure rAF loop silently
 * never advances there. It also reschedules BEFORE its early returns, so the one
 * frame where the font has not parsed yet cannot kill the loop forever.
 */
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Pencil, Type } from 'lucide-vue-next'
import { mergeConfig, type VectorTypeConfig } from '~/lib/vectortype/config'
import { loadVectorFont, type VtFont } from '~/lib/vectortype/font'
import { drawVectorTypeToCanvas, vtIsAnimated } from '~/lib/vectortype/canvas'
import { vtStillTime } from '~/lib/vectortype/presetMotion'
import { makeVectorTypeFrameSource } from '~/lib/vectortype/frameSource'
import { registerStudioBaker, unregisterStudioBaker } from '~/lib/studio/cascade'
import { registerStudioFrameSource, unregisterStudioFrameSource } from '~/lib/studio/frameSource'
import StudioRenderButton from '~/components/vue-canvas/StudioRenderButton.vue'

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

/** The persisted wrapper — config plus the canvas box, which lives outside the
 *  config in every studio. `mergeConfig` defends against a blob written by an
 *  older version, a partial save, or JSON that never went through the surface. */
const blob = computed(() => (props.data?.properties?.sailor_vectorType ?? {}) as
  { config?: unknown; canvasW?: number; canvasH?: number; background?: string | null })
const config = computed<VectorTypeConfig>(() => mergeConfig(blob.value.config))
const outW = computed(() => (typeof blob.value.canvasW === 'number' ? blob.value.canvasW : 1280))
const outH = computed(() => (typeof blob.value.canvasH === 'number' ? blob.value.canvasH : 720))
const background = computed<string | null>(() =>
  blob.value.background === null ? null : (typeof blob.value.background === 'string' ? blob.value.background : '#0b0d12'))
const previewH = computed(() => Math.max(1, Math.round(PREVIEW_W / Math.max(0.05, outW.value / Math.max(1, outH.value)))))

const canvasEl = ref<HTMLCanvasElement | null>(null)
// shallowRef + markRaw, NOT ref: a fontkit font is a live parser object with
// non-configurable properties, and Vue's deep reactive proxy over it throws
// "'get' on proxy: property 'parent' is a read-only and non-configurable data
// property" the moment anything reads a glyph. Nothing here needs the font to be
// reactive BELOW the reference — swapping families replaces the whole object.
const font = shallowRef<VtFont | null>(null)
const renderError = ref<string | null>(null)
const animated = computed(() => vtIsAnimated(config.value))

let timer = 0
let startedAt = 0
let disposed = false

async function ensureFont(id: string): Promise<VtFont> {
  const f = await loadVectorFont(id)
  if (config.value.fontId === id) font.value = markRaw(f)
  return f
}
watch(() => config.value.fontId, (id) => {
  ensureFont(id).catch((e) => { renderError.value = String(e?.message ?? e) })
}, { immediate: true })

/** See the file header — a bare rAF loop does not advance in a hidden tab. */
function schedule() {
  if (disposed) return
  if (typeof document !== 'undefined' && document.hidden) {
    timer = window.setTimeout(draw, 1000 / 30) as unknown as number
  } else {
    timer = requestAnimationFrame(draw)
  }
}

function draw() {
  // Reschedule FIRST: the early returns below are transient (font still
  // parsing, canvas not mounted) and must not be able to stop the loop.
  schedule()
  const el = canvasEl.value
  const f = font.value
  if (!el || !f) return

  let t = 0
  if (animated.value) {
    if (!startedAt) startedAt = performance.now()
    const dur = Math.max(0.1, config.value.motion?.duration ?? 4)
    t = ((performance.now() - startedAt) / 1000) % dur
  }
  try {
    drawVectorTypeToCanvas(el, f, config.value, t, {
      width: outW.value, height: outH.value, background: background.value,
      pixelRatio: PREVIEW_W / Math.max(1, outW.value),
    })
    renderError.value = null
  } catch (e: any) {
    renderError.value = String(e?.message ?? e)
  }
}

/** Headless full-res bake for the render cascade (generative — no input). */
async function bakeOutput(): Promise<Blob | null> {
  try {
    const f = font.value ?? await ensureFont(config.value.fontId)
    const off = document.createElement('canvas')
    // Not `t = 0`: with an entrance preset frame 0 is deliberately EMPTY, so a
    // still baked there would be a blank PNG (see `vtStillTime`).
    drawVectorTypeToCanvas(off, f, config.value, vtStillTime(config.value), {
      // `bake` opts a shader fill's field out of the 512px live-preview clamp, so
      // the PNG carries the field at the output's own resolution.
      width: outW.value, height: outH.value, background: background.value, bake: true,
    })
    return await new Promise<Blob | null>(resolve => off.toBlob(b => resolve(b), 'image/png'))
  } catch (e) {
    console.error('[vector-type] bake failed', e)
    return null
  }
}

onMounted(() => {
  schedule()
  registerStudioBaker(props.id, bakeOutput)
  registerStudioFrameSource(props.id, makeVectorTypeFrameSource({
    getConfig: () => config.value,
    getFont: () => ensureFont(config.value.fontId),
    getSize: () => ({ width: outW.value, height: outH.value }),
    getBackground: () => background.value,
  }))
})
onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(timer)
  clearTimeout(timer)
  unregisterStudioBaker(props.id)
  unregisterStudioFrameSource(props.id)
})

// Restart the clock when the animation state changes, so pausing/unpausing an
// edit doesn't leave the preview showing a frame from a stale timeline.
watch(animated, () => { startedAt = 0 })

function openEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openVectorType', { detail: { nodeId: props.id } }))
}

// Index of the optional `vars` input a Collection's VARS output wires into.
// Rendering its port is what lets that edge anchor and survive reload.
const varsInputIndex = computed(() =>
  ((props.data?.inputs as { name?: string }[] | undefined) ?? []).findIndex(i => i?.name === 'vars'))
</script>

<template>
  <!-- Ports live outside the card: the card clips its own content
       (overflow-hidden), which would otherwise cut the dots in half. -->
  <div class="studio-node relative w-fit">
    <VueCanvasNodePort
      v-if="varsInputIndex >= 0"
      :id="`input-${varsInputIndex}`" type="target" side="left" :index="0"
      data-type="VARS" label="variables"
    />
    <VueCanvasNodePort
      id="output-0" type="source" side="right" :index="0"
      data-type="IMAGE" label="image"
    />

    <div
      class="relative z-10 w-[220px] overflow-hidden rounded-xl border border-white/10 bg-neutral-900 text-white shadow-lg"
      @dblclick.stop="openEditor"
    >
      <div class="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Type class="h-3.5 w-3.5 text-white/70" />
        <span class="text-xs font-medium text-white/80">Vector Type</span>
        <span class="ml-auto truncate text-[10px] text-white/40">{{ config.fontId }}</span>
      </div>

      <div class="flex items-center justify-center bg-neutral-950">
        <canvas ref="canvasEl" class="block w-full" :style="{ height: previewH + 'px' }" />
      </div>
      <div v-if="renderError" class="truncate px-3 py-1 text-[10px] text-red-300/90" :title="renderError">{{ renderError }}</div>

      <div class="flex items-center gap-1.5 border-t border-white/10 p-2">
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
