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
 * The preview loop is the shared `useCanvasCardPreviewLoop` — gated (pauses
 * off-screen / tab-hidden / behind a fullscreen modal / un-hovered) and throttled
 * to 30fps (it used to repaint identical frames at the display rate). This loop is
 * ONLY the on-card thumbnail: the headless capture path (a hidden tab) pulls frames
 * through the registered frame source + baker, NOT through this loop, so pausing it
 * in a hidden tab does not affect exported output. A frame where the font has not
 * parsed yet is a no-op paint (guarded below) — the loop keeps ticking, so the next
 * frame after the font lands paints normally.
 */
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Pencil, Type } from 'lucide-vue-next'
import { mergeConfig, type VectorTypeConfig } from '~/lib/vectortype/config'
import { loadVectorFont, type VtFont } from '~/lib/vectortype/font'
import { DEFAULT_FONT_ID } from '~/data/variable-fonts'
import { parseVtFontToken, vtFontRefLabel } from '~/lib/vectortype/fontToken'
import { drawVectorTypeToCanvas, vtIsAnimated } from '~/lib/vectortype/canvas'
import { vtStillTime } from '~/lib/vectortype/presetMotion'
import { makeVectorTypeFrameSource } from '~/lib/vectortype/frameSource'
import { registerStudioBaker, unregisterStudioBaker } from '~/lib/studio/cascade'
import { registerStudioFrameSource, unregisterStudioFrameSource } from '~/lib/studio/frameSource'
import { useCanvasCardPreviewLoop } from '~/composables/useCanvasCardPreviewLoop'
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
// Separate from `renderError`: draw() clears renderError on every successful frame, which would wipe this note as soon as the Inter fallback finished rendering.
const fontNote = ref<string | null>(null)
const animated = computed(() => vtIsAnimated(config.value))
// fontId is a storage token (e.g. "google:Inter Tight@700"); the subtitle shows the human-readable name instead.
const fontLabel = computed(() => vtFontRefLabel(parseVtFontToken(config.value.fontId) ?? { kind: 'catalog', id: DEFAULT_FONT_ID }))

// IntersectionObserver + hover listeners for the shared gated/throttled preview loop.
const rootEl = ref<HTMLElement | null>(null)

// On a failed load this does what the open studio does (VectorTypeSurface's
// `loadFont`): fall back to Inter rather than leaving `font` null. Without
// this the closed card showed a bare red line and NO drawing while the same
// token, open in the studio, was drawing Inter — the two views disagreed
// about whether anything had actually gone wrong.
async function ensureFont(id: string): Promise<VtFont> {
  fontNote.value = null
  try {
    const f = await loadVectorFont(id)
    if (config.value.fontId === id) { font.value = markRaw(f); renderError.value = null }
    return f
  } catch (e) {
    // Stale by the time the await resolved — the caller already moved on.
    if (config.value.fontId !== id) throw e
    // The token's own label when it parses, the RAW string when it does not — an
    // unparseable token can only have arrived from a bound column or an agent
    // patch, and naming the default in both halves ("Couldn't load Inter —
    // showing Inter.") would hide exactly what went in. Matches VectorTypeSurface's `loadFont`.
    const parsed = parseVtFontToken(id)
    fontNote.value = `Couldn't load ${parsed ? vtFontRefLabel(parsed) : id} — showing ${vtFontRefLabel({ kind: 'catalog', id: DEFAULT_FONT_ID })}.`
    try {
      const fallback = await loadVectorFont(DEFAULT_FONT_ID)
      if (config.value.fontId === id) font.value = markRaw(fallback)
      return fallback
    } catch (fallbackError) {
      // Inter itself failed — keep the original red-line behaviour (font stays
      // null) rather than retrying, so this cannot loop.
      if (config.value.fontId === id) {
        font.value = null
        renderError.value = String((fallbackError as any)?.message ?? fallbackError)
      }
      throw fallbackError
    }
  }
}
watch(() => config.value.fontId, (id) => {
  // Already handled inside ensureFont; this only stops an unhandled rejection
  // when both the token and the Inter fallback fail to load.
  ensureFont(id).catch(() => {})
}, { immediate: true })

/** Draw one frame at clip-local time `t` (seconds). A no-op while the font or
 *  canvas isn't ready yet — the loop keeps ticking and paints once it is. */
function paint(t: number) {
  const el = canvasEl.value
  const f = font.value
  if (!el || !f) return
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

/** Static/paused poster: the config's representative still time (0 when the
 *  config has no motion, so the static preview is byte-for-byte unchanged). */
function renderStill() { paint(vtStillTime(config.value)) }

// Shared gated + fps-throttled preview loop. Pauses off-screen / tab-hidden / behind a
// fullscreen studio modal / when un-hovered; throttles to 30fps (it used to repaint
// identical frames at the display rate).
const preview = useCanvasCardPreviewLoop({
  rootEl,
  active: () => animated.value,
  fps: () => 30,
  onFrame: ({ t }) => { const dur = Math.max(0.1, config.value.motion?.duration ?? 4); paint(t % dur) },
  onIdle: renderStill,
})

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
  renderStill()   // initial static preview; the gated loop animates only while hovered/visible
  registerStudioBaker(props.id, bakeOutput)
  registerStudioFrameSource(props.id, makeVectorTypeFrameSource({
    getConfig: () => config.value,
    getFont: () => ensureFont(config.value.fontId),
    getSize: () => ({ width: outW.value, height: outH.value }),
    getBackground: () => background.value,
  }))
})
onBeforeUnmount(() => {
  unregisterStudioBaker(props.id)
  unregisterStudioFrameSource(props.id)
})

// The card used to repaint every frame, so a font load or a live config edit showed up
// on its own. The gated loop doesn't run when the card is static/paused, so repaint the
// still poster on those changes — unless the loop is actively animating (it'll pick the
// change up next tick).
function repaintStillIfIdle() { if (animated.value && preview.gateOk()) return; renderStill() }
watch(font, repaintStillIfIdle)
watch(config, repaintStillIfIdle, { deep: true })

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
  <div ref="rootEl" class="studio-node relative w-fit">
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
        <span class="ml-auto truncate text-[10px] text-white/40">{{ fontLabel }}</span>
      </div>

      <div class="flex items-center justify-center bg-neutral-950">
        <canvas ref="canvasEl" class="block w-full" :style="{ height: previewH + 'px' }" />
      </div>
      <div v-if="renderError" class="truncate px-3 py-1 text-[10px] text-red-300/90" :title="renderError">{{ renderError }}</div>
      <div v-if="fontNote" class="truncate px-3 py-1 text-[10px] text-amber-100/70" :title="fontNote">{{ fontNote }}</div>

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
