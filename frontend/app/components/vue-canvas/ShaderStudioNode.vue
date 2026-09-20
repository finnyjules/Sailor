<!-- frontend/app/components/vue-canvas/ShaderStudioNode.vue -->
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Pencil, Sparkles } from 'lucide-vue-next'
import { fetchShaderFxCatalog, resolveEffectId } from '~/lib/shaderfx/catalog'
import { shaderFx } from '~/lib/shaderfx/renderer'
import type { ShaderFxCatalog, EffectDef } from '~/lib/shaderfx/types'
import { composePasses } from '~/lib/shaderstudio/passes'
import { stackWantsClock } from '~/lib/shaderstudio/clock'
import { migrateShaderConfig } from '~/lib/shaderstudio/migrate'
import { applyMotion } from '~/lib/shaderstudio/motion'
import { makeImageSource, makeLiveSource, motionConfigFor, resolveSourceKind, type ResolvedSource } from '~/lib/shaderstudio/resolve'
import { frameSourceEpoch } from '~/lib/studio/frameSource'
import { loadImage } from '~/lib/shaderstudio/source'
import { hydrateConfig, outputDims, type ShaderStudioConfig } from '~/lib/shaderstudio/types'
import { registerStudioBaker, unregisterStudioBaker } from '~/lib/studio/cascade'
import { useCanvasCardPreviewLoop } from '~/composables/useCanvasCardPreviewLoop'
import StudioRenderButton from '~/components/vue-canvas/StudioRenderButton.vue'

const props = defineProps<{
  id: string
  data: { nodeType: string; title?: string; mode?: number; properties?: Record<string, any>; studioBusy?: boolean; inputs?: { name?: string }[] }
}>()

const PREVIEW_W = 220
const injectedEdges = inject<any>('vueFlowEdges', null)
const injectedNodes = inject<any>('vueFlowNodes', null)

const config = computed<ShaderStudioConfig>(
  () => hydrateConfig(migrateShaderConfig(props.data?.properties?.sailor_shaderStudio)),
)
const animated = computed(() => (config.value.motion?.tracks?.length ?? 0) > 0)

const canvasEl = ref<HTMLCanvasElement | null>(null)
const glError = ref<string | null>(null)
const catalog = ref<ShaderFxCatalog | null>(null)
const resolved = ref<ResolvedSource | null>(null)
// Template-compat alias: the card's placeholder text still keys off a single
// "do we have something to show" value. Kept as a computed (not a ref) purely
// so the <template> — owned by a parallel session's port migration in this
// same file — doesn't need to change from `v-if="!baseImage"`.
const baseImage = computed(() => resolved.value)

// Descriptor first (pure), then load if it is a file. Recomputes when the graph
// changes, so rewiring the input updates the card without a manual refresh.
const sourceKind = computed(() => {
  frameSourceEpoch.value  // re-resolve when any studio (un)registers a frame source
  return resolveSourceKind(props.id, injectedNodes?.value ?? [], injectedEdges?.value ?? [])
})

const ownSourceUrl = computed(() => config.value.source.dataUrl
  ?? (config.value.source.asset
    ? `/view?${new URLSearchParams({ filename: config.value.source.asset, type: 'input' })}`
    : null))

/** Animate when EITHER our own tracks run or the source itself moves. */
const sourceAnimated = computed(() => (resolved.value?.duration ?? 0) > 0)
/** …or an effect in the stack draws itself off the clock (Speed dial up, Motion mode
 *  running). Same rule as the modal — see lib/shaderstudio/clock.ts. The card's loop
 *  stays gated on hover/visibility/occlusion below; this only widens WHAT counts as
 *  moving, never WHEN the gate opens. */
const effectAnimated = computed(() => stackWantsClock(config.value.effects, effectDef))
const shouldLoop = computed(() => animated.value || sourceAnimated.value || effectAnimated.value)
// Set while bakeOutput holds the shared shaderFx canvas. renderFrame is async
// (it awaits getFrame), so a preview frame suspended at its await can resume mid-bake
// and overwrite the canvas between bake's render() and its toBlob() read — corrupting
// the blob. renderFrame bails on `baking` AFTER its await (before it touches the shared
// canvas), so a suspended tick can't corrupt the blob even though the gated loop keeps
// ticking through the bake.
let baking = false
// IntersectionObserver + hover listeners for the shared gated/throttled preview loop
// attach to this root. Declared before the immediate watch below, which resolves the
// source during setup (TDZ-safe: `renderStill` is a hoisted function, not this const).
const rootEl = ref<HTMLElement | null>(null)

watch([sourceKind, ownSourceUrl], async ([kind, ownUrl]) => {
  resolved.value = null
  if (kind?.kind === 'live') { resolved.value = makeLiveSource(kind.source); renderStill(); return }
  const url = kind?.kind === 'url' ? kind.url : ownUrl
  if (!url) { renderStill(); return }
  try {
    resolved.value = makeImageSource(await loadImage(url))
    renderStill()
  } catch { resolved.value = null }
}, { immediate: true })

function effectDef(id: string): EffectDef | null {
  return catalog.value?.effects.find(e => e.id === resolveEffectId(id)) ?? null
}

/** The card header names the first effect the way the picker does — never the raw id.
 *  Until the catalog arrives (or for an id it no longer lists) the id is spelled out. */
const headerEffectName = computed(() => {
  const id = config.value.effects[0]?.id
  if (!id) return 'No effect'
  const spaced = id.replace(/_/g, ' ')
  return effectDef(id)?.name ?? spaced.charAt(0).toUpperCase() + spaced.slice(1)
})

async function renderFrame(t01: number) {
  const el = canvasEl.value
  if (!el) return
  const src = resolved.value
  if (!src) {
    el.width = PREVIEW_W; el.height = Math.round(PREVIEW_W * 9 / 16)
    el.getContext('2d')!.clearRect(0, 0, el.width, el.height)
    return
  }
  const { w, h } = outputDims(src.width, src.height, PREVIEW_W)
  if (el.width !== w || el.height !== h) { el.width = w; el.height = h }
  try {
    const base = await src.getFrame(t01, w, h)
    // A bake may have started while this frame was suspended at the await above —
    // bail before touching the shared canvas so we can't corrupt the baked blob.
    if (baking) return
    // The clock is normalized, but motion tracks and u_time are in seconds.
    const dur = clockDuration()
    const t = t01 * dur
    // motionConfigFor is REQUIRED, not cosmetic: applyMotion divides by
    // cfg.motion.duration, so passing upstream-derived seconds against our own
    // (different) duration would run every track at the wrong rate.
    const cfg = animated.value ? applyMotion(motionConfigFor(config.value, dur), t) : config.value
    // REBASE (2026-07-19): Shader Studio moved from a single `config.effect` to
    // an `effects[]` stack, and composePasses' 2nd arg is now a RESOLVER function
    // `(id) => EffectDef | null`, not a resolved def. Pass `effectDef` (the fn)
    // directly and never reference `cfg.effect.id`. This line is unchanged from
    // the current committed file — do not "fix" it back to the old shape.
    const passes = composePasses(cfg, effectDef, t)
    el.getContext('2d')!.drawImage(shaderFx.render(passes, base, w, h), 0, 0)
    glError.value = null
  } catch (e: any) { glError.value = String(e?.message ?? e) }
}

/** Seconds per loop — the upstream source's clock when it has one, else our own. */
function clockDuration(): number {
  const src = resolved.value
  if (src && src.duration > 0) return src.duration
  return Math.max(0.1, config.value.motion?.duration ?? 4)
}

/** One-shot still (t=0) — the card's static preview and the paused/hover-leave poster. */
function renderStill() { void renderFrame(0) }

// Shared gated + fps-throttled preview loop. Pauses off-screen / tab-hidden / behind a
// fullscreen studio modal / when un-hovered; throttles to 30fps (getFrame + shaderFx is
// expensive and the display may repaint at 120Hz). The async in-flight guard skips ticks
// while a getFrame is outstanding, so a slow upstream lowers the frame rate, not lags.
const preview = useCanvasCardPreviewLoop({
  rootEl,
  active: () => shouldLoop.value,
  fps: () => 30,
  onFrame: ({ t }) => { const dur = clockDuration(); return renderFrame(((t % dur) / dur)) },
  onIdle: renderStill,
})

// Headless full-res bake for the render cascade — same pipeline as the thumbnail,
// at output resolution, with the input re-resolved fresh (picks up an upstream
// studio's just-published output during a cascade).
async function bakeOutput(): Promise<Blob | null> {
  // `baking` (set before any await) makes an in-flight preview frame bail before it
  // touches the shared shaderFx canvas — see `let baking`. The whole body is inside
  // try/finally so `baking` is always cleared and a fresh still repaints, even on the
  // no-input early return.
  baking = true
  try {
    let src = resolved.value
    // Re-resolve so a cascade picks up an upstream studio's just-published output;
    // fall back to the already-resolved source so the bake never no-ops.
    const kind = sourceKind.value
    if (kind?.kind === 'live') src = makeLiveSource(kind.source)
    else {
      const url = kind?.kind === 'url' ? kind.url : ownSourceUrl.value
      if (url) { try { src = makeImageSource(await loadImage(url)) } catch { /* keep previous */ } }
    }
    if (!src) { console.warn('[shader-studio] bake: no input for', props.id); return null }
    const { w, h } = outputDims(src.width, src.height, config.value.resolution || 1536, { upscale: true })
    const base = await src.getFrame(0, w, h)
    // REBASE (2026-07-19): resolver-fn form, effects[] stack — see the renderFrame note.
    const out = shaderFx.render(composePasses(config.value, effectDef, 0), base, w, h)
    return await new Promise<Blob | null>(res => out.toBlob(b => res(b), 'image/png'))
  } finally {
    baking = false
    renderStill()
  }
}

onMounted(async () => {
  registerStudioBaker(props.id, bakeOutput)   // register first, before the async catalog fetch
  catalog.value = await fetchShaderFxCatalog().catch(() => null)
  renderStill()   // initial static preview; the gated loop animates only while hovered/visible
})
onBeforeUnmount(() => { unregisterStudioBaker(props.id) })

let timer: ReturnType<typeof setTimeout> | null = null
// Re-render on config change. While the loop is actively animating it picks up the new
// config next tick; otherwise (paused/not hovered/static) repaint the still poster.
watch(config, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { if (shouldLoop.value && preview.gateOk()) return; renderStill() }, 60)
}, { deep: true })

function openEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openShaderStudio', { detail: { nodeId: props.id } }))
}

// Index of the optional `vars` input a Collection's VARS output wires into.
// Rendering its Handle (below) is what lets that edge anchor and survive reload.
const varsInputIndex = computed(() =>
  ((props.data?.inputs as { name?: string }[] | undefined) ?? []).findIndex(i => i?.name === 'vars'))
</script>

<template>
  <!-- Ports live outside the card: the card clips its own content
       (overflow-hidden), which would otherwise cut the dots and their hit
       areas in half. As siblings they also tuck in behind it. -->
  <div ref="rootEl" class="studio-node relative w-fit">
    <!-- Input handle (image in) -->
    <VueCanvasNodePort
      id="input-0" type="target" side="left" :index="0"
      data-type="IMAGE" label="image"
    />
    <!-- Variables input: a Collection's VARS output wires here. Rendering this
         port lets the VARS edge anchor so it survives reload (fixes
         edge-lost-on-restart). It stacks BELOW the image input — both used to
         sit at top: 50%, completely overlapping, so one was unreachable. -->
    <VueCanvasNodePort
      v-if="varsInputIndex >= 0"
      :id="`input-${varsInputIndex}`" type="target" side="left" :index="1"
      data-type="VARS" label="variables"
    />
    <!-- Output handle (provenance to generated Image/Video) -->
    <VueCanvasNodePort
      id="output-0" type="source" side="right" :index="0"
      data-type="IMAGE" label="image"
    />

  <div
    class="relative z-10 w-[220px] overflow-hidden rounded-xl border border-white/10 bg-neutral-900 text-white shadow-lg"
    @dblclick.stop="openEditor"
  >
    <div class="flex items-center gap-2 border-b border-white/10 px-3 py-2">
      <Sparkles class="h-3.5 w-3.5 text-white/70" />
      <span class="text-xs font-medium text-white/80">Shader Studio</span>
      <span class="ml-auto truncate text-[10px] tracking-wide text-white/40">{{ headerEffectName }}</span>
    </div>

    <div class="flex items-center justify-center bg-neutral-950 aspect-video">
      <canvas ref="canvasEl" class="block max-h-full max-w-full" />
      <span v-if="!baseImage" class="absolute text-[10px] text-white/30">Connect or add an image</span>
    </div>
    <div v-if="glError" class="px-3 py-1 text-[10px] text-red-300/90 truncate" :title="glError">{{ glError }}</div>

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
