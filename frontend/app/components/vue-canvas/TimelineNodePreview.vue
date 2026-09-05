<script setup lang="ts">
/**
 * Animated thumbnail preview for the Timeline node, embedded in the node body.
 * Draws hidden <video> elements per connected clip onto a canvas, advancing a
 * virtual playhead and looping at total duration. The loop is the shared
 * `useCanvasCardPreviewLoop` — gated (pauses off-screen / tab-hidden / behind a
 * fullscreen modal / un-hovered, pausing the videos with it) and throttled to the
 * timeline's FPS; the playhead is derived from that loop's clock.
 *
 * Independent of the modal — both can coexist; each maintains its own
 * <video> pool so neither steps on the other's currentTime/play state.
 */
import { resolveClipSource } from '~~/shared/timeline/resolveClipSource'
import { interpolateClipAt } from '~~/shared/timeline/interpolate'
import type { Keyframe } from '~~/shared/timeline/types'
import { migrateEditState } from '~~/shared/timeline/types'

const props = defineProps<{ nodeId: string }>()

const injectedNodes = inject<any>('vueFlowNodes', null)
const injectedEdges = inject<any>('vueFlowEdges', null)

const FPS = computed<number>(() => {
  const v = Number(getWidget('output_fps') ?? 30)
  return v >= 1 && v <= 120 ? v : 30
})

const BLEND_MAP: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  soft_light: 'soft-light',
  hard_light: 'hard-light',
  difference: 'difference',
  lighten: 'lighten',
  darken: 'darken',
  add: 'lighter',
}

const node = computed(() => injectedNodes?.value?.find((n: any) => n.id === props.nodeId))

function getWidget(name: string): any {
  const defs = node.value?.data?.widgetDefs as any[] | undefined
  const wv = node.value?.data?.widgetsValues as any[] | undefined
  if (!defs || !wv) return undefined
  const i = defs.findIndex((d: any) => d.name === name)
  return i >= 0 ? wv[i] : undefined
}

function resolveSource(slot: number): { url: string; kind: 'video' | 'image' | 'sequence'; urls?: string[] } | null {
  if (!injectedEdges?.value || !injectedNodes?.value) return null
  const edge = injectedEdges.value.find((e: any) =>
    e.target === props.nodeId && e.targetHandle === `input-${slot - 1}`)
  if (!edge) return null
  const src = injectedNodes.value.find((n: any) => n.id === edge.source)
  return resolveClipSource(src)
}

interface PreviewLayer {
  slot: number
  start: number
  length: number
  x: number; y: number
  rotation: number; scale: number
  opacity: number; blend: string
  fadeIn: number; fadeOut: number
  srcUrl: string | null
  srcKind: 'video' | 'image' | 'sequence' | null
  srcUrls?: string[]    // for sequence sources (baked frame sequences)
  inFrame: number
  keyframes?: Keyframe[]   // present ⇒ transform animates over clip-local frames
}

const layers = computed<PreviewLayer[]>(() => {
  const n = node.value
  if (!n) return []

  // Prefer the editor's edit_state — clips added via the Timeline editor live
  // here as `workflow` clips with real timing. The legacy clip{i}_* widgets are
  // only populated when wiring without the editor.
  const rawState = n.data?.properties?.edit_state
  if (rawState) {
    try {
      const parsed = typeof rawState === 'string' ? JSON.parse(rawState) : rawState
      const st = migrateEditState(parsed)
      if (st && Array.isArray(st.tracks)) {
        const out: PreviewLayer[] = []
        for (const track of st.tracks) {
          if (track.muted || track.kind === 'audio') continue
          for (const clip of track.clips || []) {
            if (clip.kind !== 'workflow') continue
            const src = resolveSource(Number(clip.port_index ?? 0))
            out.push({
              slot: Number(clip.port_index ?? 0),
              start: Number(clip.start_frame ?? 0), length: Number(clip.length ?? 30),
              x: Number(clip.x ?? 0), y: Number(clip.y ?? 0),
              rotation: Number(clip.rotation ?? 0), scale: Number(clip.scale ?? 1),
              opacity: Number(clip.opacity ?? 1), blend: String(clip.blend ?? 'normal'),
              fadeIn: Number(clip.fade_in ?? 0), fadeOut: Number(clip.fade_out ?? 0),
              inFrame: Number(clip.in_frame ?? 0),
              keyframes: Array.isArray(clip.keyframes) ? clip.keyframes : undefined,
              srcUrl: src?.url ?? null, srcKind: src?.kind ?? null, srcUrls: src?.urls,
            })
          }
        }
        if (out.length) return out
      }
    } catch { /* fall through to legacy */ }
  }

  const out: PreviewLayer[] = []
  for (let i = 1; i <= 4; i++) {
    const edge = injectedEdges?.value?.find((e: any) =>
      e.target === props.nodeId && e.targetHandle === `input-${i - 1}`)
    if (!edge) continue
    const src = resolveSource(i)
    out.push({
      slot: i,
      start:    Number(getWidget(`clip${i}_start`)    ?? 0),
      length:   Number(getWidget(`clip${i}_length`)   ?? 30),
      x:        Number(getWidget(`clip${i}_x`)        ?? 0),
      y:        Number(getWidget(`clip${i}_y`)        ?? 0),
      rotation: Number(getWidget(`clip${i}_rotation`) ?? 0),
      scale:    Number(getWidget(`clip${i}_scale`)    ?? 1),
      opacity:  Number(getWidget(`clip${i}_opacity`)  ?? 1),
      blend:    String(getWidget(`clip${i}_blend`)    ?? 'normal'),
      fadeIn:   Number(getWidget(`clip${i}_fade_in`)  ?? 0),
      fadeOut:  Number(getWidget(`clip${i}_fade_out`) ?? 0),
      inFrame:  0,
      srcUrl:   src?.url ?? null,
      srcKind:  src?.kind ?? null,
      srcUrls:  src?.urls,
    })
  }
  return out
})

const totalDuration = computed<number>(() => {
  const explicit = Number(getWidget('total_duration') ?? 0)
  if (explicit > 0) return explicit
  return layers.value.reduce((m, L) => Math.max(m, L.start + L.length), 1)
})
const bgColor = computed(() => String(getWidget('bg_color') ?? '#000000'))

// Per-slot media elements, owned by this component.
const videos: Record<number, HTMLVideoElement> = {}
const images: Record<number, HTMLImageElement> = {}
// Per-slot frame sequences: preloaded image arrays + the url
// signature used to detect when a re-bake changed the frame list.
const sequences: Record<number, HTMLImageElement[]> = {}
const sequenceKeys: Record<number, string> = {}

function ensureVideo(slot: number, url: string): HTMLVideoElement {
  let v = videos[slot]
  const targetSrc = new URL(url, window.location.href).href
  if (!v) {
    v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.crossOrigin = 'anonymous'
    videos[slot] = v
  }
  if (v.src !== targetSrc) {
    v.src = url
    v.load()
  }
  return v
}

function ensureImage(slot: number, url: string): HTMLImageElement {
  let img = images[slot]
  const targetSrc = new URL(url, window.location.href).href
  if (!img) {
    img = new Image()
    img.crossOrigin = 'anonymous'
    images[slot] = img
  }
  if (img.src !== targetSrc) {
    img.src = url
  }
  return img
}

/** Preload a frame sequence for a slot (idempotent — only rebuilds when the
 *  url list changes, e.g. after a re-bake). */
function ensureSequence(slot: number, urls: string[]) {
  const key = `${urls.length}:${urls[0] ?? ''}`
  if (sequenceKeys[slot] === key && sequences[slot]) return
  sequenceKeys[slot] = key
  sequences[slot] = urls.map(u => {
    const im = new Image()
    im.crossOrigin = 'anonymous'
    im.src = u
    return im
  })
}

watch(layers, (curr) => {
  const liveVideos = new Set<number>()
  const liveImages = new Set<number>()
  const liveSequences = new Set<number>()
  for (const L of curr) {
    if (L.srcKind === 'video' && L.srcUrl) {
      liveVideos.add(L.slot)
      ensureVideo(L.slot, L.srcUrl)
    } else if (L.srcKind === 'image' && L.srcUrl) {
      liveImages.add(L.slot)
      ensureImage(L.slot, L.srcUrl)
    } else if (L.srcKind === 'sequence' && L.srcUrls?.length) {
      liveSequences.add(L.slot)
      ensureSequence(L.slot, L.srcUrls)
    }
  }
  for (const k of Object.keys(videos).map(Number)) {
    if (!liveVideos.has(k)) {
      try { videos[k]!.pause(); videos[k]!.removeAttribute('src'); videos[k]!.load() } catch {}
      delete videos[k]
    }
  }
  for (const k of Object.keys(images).map(Number)) {
    if (!liveImages.has(k)) delete images[k]
  }
  for (const k of Object.keys(sequences).map(Number)) {
    if (!liveSequences.has(k)) { delete sequences[k]; delete sequenceKeys[k] }
  }
}, { immediate: true, deep: true })

// Playhead in seconds. Driven by the shared preview loop's clock (t, wrapped at
// totalDuration / FPS), so it resets to 0 on pause/hover-leave — the hover-to-play poster.
const playheadSec = ref(0)

// IntersectionObserver + hover listeners for the shared gated/throttled preview loop.
const rootEl = ref<HTMLElement | null>(null)

// Canvas size auto-detected from the first loaded video, clamped for thumbnail.
const canvasRef = ref<HTMLCanvasElement | null>(null)
const cW = ref(240)
const cH = ref(135)

function refreshCanvasSize() {
  for (const L of layers.value) {
    let w = 0, h = 0
    if (L.srcKind === 'video') {
      const v = videos[L.slot]
      if (v) { w = v.videoWidth; h = v.videoHeight }
    } else if (L.srcKind === 'image') {
      const img = images[L.slot]
      if (img && img.complete) { w = img.naturalWidth; h = img.naturalHeight }
    } else if (L.srcKind === 'sequence') {
      const seq = sequences[L.slot]
      const first = seq?.find(im => im.complete && im.naturalWidth > 0)
      if (first) { w = first.naturalWidth; h = first.naturalHeight }
    }
    if (w > 0 && h > 0) {
      const max = 320
      const longEdge = Math.max(w, h)
      const scale = longEdge > max ? max / longEdge : 1
      cW.value = Math.max(1, Math.round(w * scale))
      cH.value = Math.max(1, Math.round(h * scale))
      return
    }
  }
}

// Paint the composite at the current `playheadSec`. `still` (poster mode) keeps every
// video PAUSED instead of driving playback — used when the loop is stopped.
function paint(still = false) {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  if (canvas.width !== cW.value) canvas.width = cW.value
  if (canvas.height !== cH.value) canvas.height = cH.value

  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = bgColor.value
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const totalSec = totalDuration.value / FPS.value

  for (const L of layers.value) {
    const startSec = L.start / FPS.value
    const endSec = (L.start + L.length) / FPS.value
    const active = playheadSec.value >= startSec && playheadSec.value < endSec

    // Pick the source element + drive video playback.
    let media: HTMLVideoElement | HTMLImageElement | null = null
    let srcW = 0, srcH = 0
    if (L.srcKind === 'video') {
      const v = videos[L.slot]
      if (!v) continue
      if (!active) { if (!v.paused) v.pause(); continue }
      const dur = v.duration
      if (!isFinite(dur) || dur <= 0) continue
      const localSec = playheadSec.value - startSec
      const target = ((localSec % dur) + dur) % dur
      if (still) {
        // Poster: hold the current decoded frame, but never leave the video playing.
        if (!v.paused) v.pause()
      } else if (v.paused) {
        try { v.currentTime = target } catch {}
        v.play().catch(() => {})
      } else if (Math.abs(v.currentTime - target) > 0.2) {
        try { v.currentTime = target } catch {}
      }
      media = v
      srcW = v.videoWidth; srcH = v.videoHeight
    } else if (L.srcKind === 'image') {
      const img = images[L.slot]
      if (!img || !img.complete || img.naturalWidth === 0) continue
      if (!active) continue
      media = img
      srcW = img.naturalWidth; srcH = img.naturalHeight
    } else if (L.srcKind === 'sequence') {
      const seq = sequences[L.slot]
      if (!seq?.length) continue
      if (!active) continue
      // Index into the frame sequence by clip-local frame, looping.
      const localFrame = Math.floor((playheadSec.value - startSec) * FPS.value)
      const idx = ((localFrame + L.inFrame) % seq.length + seq.length) % seq.length
      const img = seq[idx]
      if (!img || !img.complete || img.naturalWidth === 0) continue
      media = img
      srcW = img.naturalWidth; srcH = img.naturalHeight
    } else {
      continue
    }
    if (!media || srcW === 0 || srcH === 0) continue

    const localSec = playheadSec.value - startSec
    const localFrame = localSec * FPS.value
    let fade = 1
    if (L.fadeIn > 0 && localFrame < L.fadeIn) fade *= localFrame / L.fadeIn
    if (L.fadeOut > 0 && localFrame > L.length - L.fadeOut) {
      fade *= (L.length - localFrame) / L.fadeOut
    }
    fade = Math.max(0, Math.min(1, fade))

    // Per-frame transform: lerp between keyframes (or static scalars when none).
    // Same shared helper as the editor preview, FFmpeg export, and node run.
    const tf = interpolateClipAt(L, localFrame)

    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, tf.opacity * fade))
    ctx.globalCompositeOperation = BLEND_MAP[L.blend] ?? 'source-over'

    const cAspect = canvas.width / canvas.height
    const sAspect = srcW / srcH
    let fitW: number, fitH: number
    if (sAspect > cAspect) { fitW = canvas.width; fitH = canvas.width / sAspect }
    else                   { fitH = canvas.height; fitW = canvas.height * sAspect }

    const cx = canvas.width / 2 + tf.x * canvas.width
    const cy = canvas.height / 2 + tf.y * canvas.height
    ctx.translate(cx, cy)
    ctx.rotate((tf.rotation * Math.PI) / 180)
    ctx.scale(tf.scale, tf.scale)
    try { ctx.drawImage(media as CanvasImageSource, -fitW / 2, -fitH / 2, fitW, fitH) } catch {}
    ctx.restore()
  }
}

/** Pause every pooled video — the loop is stopping, so nothing should keep decoding. */
function pauseAllVideos() {
  for (const slot of Object.keys(videos).map(Number)) {
    const v = videos[slot]
    if (v && !v.paused) { try { v.pause() } catch {} }
  }
}

const hasAnySource = computed(() => layers.value.some(L => L.srcUrl))

// Shared gated + fps-throttled preview loop. Pauses off-screen / tab-hidden / behind a
// fullscreen studio modal / when un-hovered; throttles to the timeline's own FPS. The
// playhead is derived from the loop's clock so it wraps at total duration and resets to
// 0 on pause (the poster).
useCanvasCardPreviewLoop({
  rootEl,
  active: () => hasAnySource.value,
  fps: () => FPS.value,
  onFrame: ({ t }) => {
    const totalSec = totalDuration.value / FPS.value
    playheadSec.value = totalSec > 0 ? t % totalSec : 0
    paint()
  },
  onIdle: () => { playheadSec.value = 0; pauseAllVideos(); paint(true) },
})

onMounted(() => {
  paint(true)   // initial poster; the gated loop animates only while hovered/visible
  // Refresh canvas size as videos finish loading metadata.
  for (const slot of Object.keys(videos).map(Number)) {
    const v = videos[slot]
    if (v) v.addEventListener('loadedmetadata', () => setTimeout(refreshCanvasSize, 0))
  }
  setTimeout(refreshCanvasSize, 200)
})

// Add loadedmetadata listeners to newly-created videos too.
watch(layers, () => {
  for (const L of layers.value) {
    const v = videos[L.slot]
    if (v && !v.dataset.metaWired) {
      v.dataset.metaWired = '1'
      v.addEventListener('loadedmetadata', () => setTimeout(refreshCanvasSize, 0))
    }
  }
})

onUnmounted(() => {
  // The rAF loop is owned (and cancelled) by useCanvasCardPreviewLoop's scope dispose.
  for (const slot of Object.keys(videos).map(Number)) {
    const v = videos[slot]
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load() } catch {} }
    delete videos[slot]
  }
})
</script>

<template>
  <div ref="rootEl" class="w-full bg-black rounded-lg overflow-hidden ring-1 ring-white/5">
    <canvas
      ref="canvasRef"
      class="w-full block"
      :style="{ aspectRatio: `${cW}/${cH}` }"
    />
    <div v-if="!hasAnySource" class="absolute inset-0 flex items-center justify-center text-[10px] text-white/30 italic pointer-events-none">
      Connect clips
    </div>
  </div>
</template>
