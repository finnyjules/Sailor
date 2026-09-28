<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { Sparkles } from 'lucide-vue-next'
import { SpaceTypeEngine } from '~/lib/spacetype/engine'
import { detectWebGL } from '~/lib/spacetype/webgl'
import { getEffect } from '~/lib/spacetype/effects'
import { loopMultiplier } from '~/lib/spacetype/loop'
import { effectiveLoopSeconds } from '~/lib/compositor/loopReconcile'
import {
  defaultSpaceTypeState, dimsFromState, ensureSpaceTypeStateFont, texOptsFromState,
  type SpaceTypeState,
} from '~/lib/spacetype/state'
import { DEFAULT_POST } from '~/lib/spacetype/post'
import { loadSpaceDefaults, spaceDefaultFor } from '~/composables/useSpaceDefaults'
import { applySceneToState } from '~/lib/spacetype/scene'
import { registerStudioBaker, unregisterStudioBaker } from '~/lib/studio/cascade'
import { registerStudioFrameSource, unregisterStudioFrameSource } from '~/lib/studio/frameSource'
import { onCanvasOcclusion } from '~/lib/studio/occlusion'
import { makeSpaceTypeFrameSource } from '~/lib/spacetype/frameSource'
import { createWiredSpaceTypeRenderer } from '~/lib/spacetype/wiredRenderer'
import { spaceTypeWiredEmbed } from '~/lib/spacetype/embedConfig'
import { syncImageTextures } from '~/lib/spacetype/imageTextures'
import { fetchShaderFxCatalog } from '~/lib/shaderfx/catalog'
import { loadGoogleCatalog } from '~/data/google-fonts'
import { useNodeGlass } from '~/composables/useCanvasGlass'
import StudioRenderButton from '~/components/vue-canvas/StudioRenderButton.vue'
import NodeOpenBar from '~/components/vue-canvas/surfaces/NodeOpenBar.vue'

// Space Type — a frontend-only config node for the client-side Three.js ribbon
// typography editor. No inputs/outputs (no backend class_type), so it never
// enters an executed prompt. The card shows a LIVE animated preview driven by
// the node's saved config; "Edit" (bottom) reopens the SpaceTypeSurface modal
// bound to this node, which writes its config back to node.data.properties.
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

const PREVIEW_W = 204
const MIN_H = 80
const MAX_H = 160
// Supersample factor for the headless bake (render N× then downscale → clean edges).
const BAKE_SS = 2

// Live view of the node's saved config (falls back to defaults for a fresh node).
const state = computed<SpaceTypeState>(
  () => (props.data?.properties?.sailor_spaceType as SpaceTypeState) ?? defaultSpaceTypeState(),
)

// True if the node already had a saved config at mount time; false = fresh node → apply default scene.
const hadSavedConfig = !!props.data?.properties?.sailor_spaceType

function previewHeight(s: SpaceTypeState): number {
  const [cw, ch] = dimsFromState(s)
  const h = Math.round(PREVIEW_W * ch / cw)
  return Math.max(MIN_H, Math.min(MAX_H, h))
}

const canvasEl = ref<HTMLCanvasElement | null>(null)
const previewH = ref(previewHeight(state.value))
// Engine is a plain (non-reactive) handle — never wrap a WebGL renderer in a Vue proxy.
let engine: SpaceTypeEngine | null = null
// A SECOND engine, separate from the card-preview `engine`, dedicated to the
// cross-studio frame source (~/lib/spacetype/wiredRenderer — lazily created on first
// pull, its own offscreen canvas). Shared with the Frame export's parity harness, so
// what a wired layer shows and what that harness measures are one code path.
const wired = createWiredSpaceTypeRenderer()
let raf = 0
let previewStart = 0
const renderError = ref<string | null>(null)
const webglOk = ref(true)

let io: IntersectionObserver | null = null
let onVisibility: (() => void) | null = null
let unsubOcclusion: (() => void) | null = null
// `occluded` covers ANY fullscreen studio modal over the canvas — including this
// node's OWN Space Type modal AND every other card's, via the one canonical signal
// (~/lib/studio/occlusion.ts). That's what fixes the old bug where OTHER Space Type
// cards kept rendering behind a Space Type modal: the nodeId-filtered `editing` flag
// only paused the one being edited. While a modal is open the wired consumer pulls
// from the HEADLESS engine, so pausing this card preview loses nothing visible.
const gate = { visible: true, tabActive: true, occluded: false, hovered: false }

function applyGate() {
  const shouldRun = gate.visible && gate.tabActive && !gate.occluded && gate.hovered && !!engine && webglOk.value
  if (shouldRun && !raf) startPreview()
  else if (!shouldRun && raf) stopPreview()
}

// A Showcase's image cards are preloaded into the card engine before its synchronous
// build (see syncImageTextures) — without this the card, and anything wired to it, shows
// blank cards where the photos should be. Every caller rebuilds straight after.
async function syncCardImages() {
  const eng = engine
  if (eng) await syncImageTextures(eng, state.value.effectId, state.value.params, () => engine === eng)
}

function rebuild() {
  if (!engine) return
  const s = state.value
  engine.setSize(PREVIEW_W, previewH.value)
  engine.setFps(s.fps)
  engine.setLoopDuration(s.loopDuration)
  engine.setBackground(s.transparent, s.bgColor)
  engine.setProjection(s.projection ?? 'perspective')
  engine.setPost({ ...(s.post ?? DEFAULT_POST) })
  engine.setPan(s.panX ?? 0, s.panY ?? 0)
  // Honor a config effectId change (the deep watch on `state` calls rebuild()).
  engine.setEffect(getEffect(s.effectId))
  engine.build(s.params, texOptsFromState(s))
  if (!raf) renderPoster()   // idle card shows a static first frame (hover-to-play)
}

// Hover-to-play: the card animates only while the pointer is over the node (gate.hovered);
// otherwise it holds frame 0. renderPoster paints that first frame; startPreview resets the
// clock so hovering always plays from the start.
//
// The text texture is baked (synchronously) inside engine.build(); a bake that runs in the
// window after document.fonts.load() resolves but before the font is active in the canvas
// text rasterizer captures the FALLBACK face. The old always-on preview loop hid this — it
// re-rendered forever, and any later rebuild (e.g. loadGoogleCatalog) re-baked and was shown.
// A single idle poster gets no such second chance, so re-bake + repaint once document.fonts
// guarantees the face is ready. Guarded so a font change, hover, or unmount mid-wait wins.
function renderPoster() {
  if (raf || !engine) return
  engine.renderFrame(0, state.value.params)
  if (typeof document === 'undefined' || !document.fonts?.ready) return
  const font = String(state.value.params.font)
  document.fonts.ready.then(() => {
    if (raf || !engine || String(state.value.params.font) !== font) return
    engine.build(state.value.params, texOptsFromState(state.value))
    engine.renderFrame(0, state.value.params)
  })
}
function onNodeHoverEnter() { gate.hovered = true; applyGate() }
function onNodeHoverLeave() { gate.hovered = false; applyGate(); renderPoster() }

function startPreview() {
  previewStart = 0
  const tick = (ts: number) => {
    if (!engine) return
    if (!previewStart) previewStart = ts
    const s = state.value
    const total = Math.max(1, Math.round(s.fps * s.loopDuration))
    const frame = Math.floor(((ts - previewStart) / 1000) * s.fps) % total
    engine.renderFrame(frame, s.params)
    renderError.value = engine.lastError
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}

function stopPreview() {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

onMounted(async () => {
  if (!canvasEl.value) return

  // Apply a default scene to a fresh node (no saved config) BEFORE building the engine,
  // so state.value already reflects the scene when the engine constructor runs.
  if (!hadSavedConfig) {
    await loadSpaceDefaults()
    const base = defaultSpaceTypeState()
    const scene = spaceDefaultFor(base.effectId)
    if (scene) {
      const merged = applySceneToState(base, scene)
      const n = props.data
      if (n) { (n.properties ||= {}).sailor_spaceType = merged }
    }
  }

  if (!detectWebGL()) { webglOk.value = false; return }
  const s = state.value
  previewH.value = previewHeight(s)
  engine = new SpaceTypeEngine(canvasEl.value, {
    effect: getEffect(s.effectId), width: PREVIEW_W, height: previewH.value,
    fps: s.fps, loopDuration: s.loopDuration, alpha: s.transparent, bgColor: s.bgColor,
    projection: s.projection ?? 'perspective',
  })
  await ensureSpaceTypeStateFont(s)
  await syncCardImages()
  rebuild()
  // Weight pinning for static families (texOptsFromState) reads the Google
  // catalog cache; module-cached, one fetch per page. Rebuild both engines when
  // it lands so a static font drops its faux-bold without opening the modal.
  void loadGoogleCatalog().then(() => { wired.markDirty(); rebuild() })
  registerStudioBaker(props.id, bakeOutput)
  // Modal-independent live frame source: a directly-wired downstream Shader Studio
  // pulls frames from here even when this node's editor is closed. Uses its OWN
  // lazily-created headless engine (the wired renderer), not the card-preview `engine`.
  // renderAt honors the requested w/h, so a chained export is full-resolution.
  const getClock = () => {
    const s = state.value
    const [cw, ch] = dimsFromState(s)
    const k = s.seamless ? loopMultiplier(getEffect(s.effectId).loopRates?.(s.params) ?? []) : 1
    return { duration: effectiveLoopSeconds(s.loopDuration, k), fps: s.fps, width: cw, height: ch }
  }
  registerStudioFrameSource(props.id, makeSpaceTypeFrameSource({
    getClock,
    // A getter, so a config saved while image cards load is read fresh after the await.
    renderAt: (t01, w, h) => wired.render(() => state.value, t01, w, h),
    // A Frame export plays this layer with the Space Type embed player when that is proven
    // faithful (spaceTypeWiredEmbed's blockers + verified list); otherwise null → frames.
    embed: () => spaceTypeWiredEmbed(state.value, getClock()),
  }))
  io = new IntersectionObserver(([entry]) => { gate.visible = !!entry?.isIntersecting; applyGate() }, { threshold: 0.01 })
  if (canvasEl.value?.parentElement) io.observe(canvasEl.value.parentElement)
  onVisibility = () => { gate.tabActive = !document.hidden; applyGate() }
  document.addEventListener('visibilitychange', onVisibility)
  unsubOcclusion = onCanvasOcclusion((open) => { gate.occluded = open; applyGate() })
  applyGate()
})

// Headless full-res frame for the render cascade (generative — no input). Renders
// frame 0 at the configured output dims, then restores the live preview.
async function bakeOutput(): Promise<Blob | null> {
  if (!engine) return null
  const s = state.value
  const [cw, ch] = dimsFromState(s)
  stopPreview()
  try {
    // Item 8 (final review): this is a one-shot render-cascade bake, not the live preview
    // loop — a shader fill whose effect isn't in the catalog YET at the `engine.build()` call
    // below gets no second chance to self-heal, and its fallback pixels get PERSISTED as the
    // uploaded PNG. Await the catalog first, same guard as ShapeStudioNode.bakeOutput /
    // Scene3DStudioNode.rebakePasses. A plain `try`, not `.catch()` on the call's return value:
    // `fetchShaderFxCatalog` throws SYNCHRONOUSLY outside a Nuxt runtime context, which
    // `.catch()` cannot intercept (see spaceTypeClipBake.ts's identical guard for the full why).
    try { await fetchShaderFxCatalog() } catch { /* offline/backend down, or non-Nuxt context — bake proceeds and falls back same as before */ }
    await ensureSpaceTypeStateFont(s)
    // Important 5 (final review): this IS an export (the studio render cascade), not the
    // live preview — without setBake(true) a shader fill stayed clamped to the LIVE_FIELD_PX
    // live-preview field size (engine.build's withShaderFillContext hardcoded `this._bake`,
    // which was never set true anywhere), so every cascade bake rendered an upscaled 512²
    // field instead of one built at the real (supersampled) output resolution.
    engine.setBake(true)
    engine.setSize(cw * BAKE_SS, ch * BAKE_SS)
    engine.setBackground(s.transparent, s.bgColor)
    engine.setEffect(getEffect(s.effectId))
    engine.build(s.params, texOptsFromState(s))
    engine.renderFrame(0, s.params)
    return await engine.frameToBlob(cw, ch)
  } catch (e) {
    console.error('[space-type] bake failed', e); return null
  } finally {
    engine.setBake(false)   // restore the live-preview clamp before rebuild() resumes it
    previewH.value = previewHeight(s)
    rebuild()
    applyGate()
  }
}

onBeforeUnmount(() => {
  stopPreview()
  io?.disconnect(); io = null
  if (onVisibility) document.removeEventListener('visibilitychange', onVisibility)
  unsubOcclusion?.()
  unregisterStudioBaker(props.id)
  unregisterStudioFrameSource(props.id)
  engine?.dispose()
  engine = null
  wired.dispose()
})

// The modal writes config back to node.data.properties on edits — rebuild the
// node preview live when that changes. Debounced so a burst of slider edits
// (deep watch fires per keystroke) coalesces into one rebuild.
let rebuildTimer: ReturnType<typeof setTimeout> | null = null
watch(state, (s) => {
  if (rebuildTimer) clearTimeout(rebuildTimer)
  wired.markDirty()   // next frame-source pull rebuilds the (lazy) headless engine
  rebuildTimer = setTimeout(async () => {
    rebuildTimer = null
    if (!engine) return
    previewH.value = previewHeight(s)
    await ensureSpaceTypeStateFont(s)
    await syncCardImages()
    rebuild()
  }, 80)
}, { deep: true })

const text = computed(() => String(state.value.params.text ?? 'Sailor'))

// Index of the optional `vars` input a Collection's VARS output wires into.
// Rendering its Handle (below) is what lets that edge anchor and survive reload.
const varsInputIndex = computed(() =>
  ((props.data?.inputs as { name?: string }[] | undefined) ?? []).findIndex(i => i?.name === 'vars'))

function openEditor() {
  window.dispatchEvent(new CustomEvent('sailor:openSpaceType', { detail: { nodeId: props.id } }))
}
</script>

<template>
  <!-- Ports live OUTSIDE the card: the card clips its own content (overflow-hidden),
       which would otherwise cut the port dots and their hit areas in half — the bug
       that stopped Type Studio connecting. As siblings they tuck in behind it.
       Mirrors GradientStudioNode / the shared port migration. -->
  <div class="studio-node relative w-fit" @pointerenter="onNodeHoverEnter" @pointerleave="onNodeHoverLeave">
    <!-- Variables input: a Collection's VARS output wires here. Rendering this port
         lets the VARS edge anchor so it survives reload (fixes edge-lost-on-restart). -->
    <VueCanvasNodePort
      v-if="varsInputIndex >= 0"
      :id="`input-${varsInputIndex}`" type="target" side="left" :index="0"
      data-type="VARS" label="variables"
    />

    <!-- Output: anchors the provenance edge to a generated Image/Video node. -->
    <VueCanvasNodePort
      id="output-0" type="source" side="right" :index="0"
      data-type="IMAGE" label="output"
    />

    <div
      class="space-type-card node-shell relative z-10 w-[240px]"
      :data-glass-blur="glass || undefined"
      :data-selected="selected || undefined"
      @dblclick.stop="openEditor"
    >
    <div class="node-shell__head">
      <Sparkles class="node-shell__icon" />
      <span class="node-shell__title">Kinetic Studio</span>
    </div>

    <!-- Live animated preview -->
    <div class="node-shell__body">
      <div class="node-well node-openbar-host">
        <div class="relative flex items-center justify-center">
          <canvas v-if="webglOk" ref="canvasEl" class="block w-full" :style="{ height: previewH + 'px' }" />
          <div v-else class="flex w-full items-center justify-center px-3 text-center text-[10px] text-white/40"
               :style="{ height: previewH + 'px' }">3D preview unavailable</div>
          <div v-if="renderError"
               class="absolute inset-x-2 bottom-2 rounded border border-amber-400/30 bg-black/70 px-2 py-1 text-[9px] text-amber-200/90">
            Render error
          </div>
        </div>
        <NodeOpenBar :meta="text">
          <button type="button" class="node-btn nopan nodrag" @click.stop="openEditor">Open</button>
        </NodeOpenBar>
      </div>
    </div>

    <div class="node-shell__foot justify-end">
      <StudioRenderButton :node-id="id" :busy="!!data?.studioBusy" />
    </div>
    </div>
  </div>
</template>
