<script setup lang="ts">
import { X, Play, Pause, RotateCw } from 'lucide-vue-next'
import { resolveClipSource, type ClipSource } from '~~/shared/timeline/resolveClipSource'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'

const props = defineProps<{
  nodeId: string
  nodes: any[]
  edges: any[]
}>()

const emit = defineEmits<{ close: [] }>()

const FPS = 30  // Same assumption Crossfade uses for frame ↔ second.
const CURVES = ['linear', 'ease_in', 'ease_out', 'ease_in_out'] as const

// -- Widget access -----------------------------------------------------------

const node = computed(() => props.nodes.find((n: any) => n.id === props.nodeId))
function widgetIdx(name: string): number {
  return (node.value?.data?.widgetDefs as any[] | undefined)
    ?.findIndex((d: any) => d.name === name) ?? -1
}
function getValue(name: string): any {
  const i = widgetIdx(name)
  if (i < 0) return undefined
  return node.value.data.widgetsValues[i]
}
function setValue(name: string, v: any) {
  const i = widgetIdx(name)
  if (i < 0) return
  node.value.data.widgetsValues[i] = v
}

const duration = computed<number>({
  get: () => Number(getValue('duration') ?? 12),
  set: v => setValue('duration', Math.max(1, Math.round(v))),
})
const curve = computed<string>({
  get: () => String(getValue('curve') ?? 'ease_in_out'),
  set: v => setValue('curve', v),
})

// Trim widgets. -1 on trim_out means "to end".
const trimInA  = computed<number>({ get: () => Number(getValue('trim_in_a') ?? 0),  set: v => setValue('trim_in_a',  Math.max(0, Math.round(v))) })
const trimOutA = computed<number>({ get: () => Number(getValue('trim_out_a') ?? -1), set: v => setValue('trim_out_a', Math.round(v)) })
const trimInB  = computed<number>({ get: () => Number(getValue('trim_in_b') ?? 0),  set: v => setValue('trim_in_b',  Math.max(0, Math.round(v))) })
const trimOutB = computed<number>({ get: () => Number(getValue('trim_out_b') ?? -1), set: v => setValue('trim_out_b', Math.round(v)) })

// Effective trim ranges. videoXDur is in seconds → convert to frames; -1 stays as "end".
const sourceFramesA = computed(() => Math.max(1, Math.round(videoADur.value * FPS)) || (imageAReady.value ? 1 : 1))
const sourceFramesB = computed(() => Math.max(1, Math.round(videoBDur.value * FPS)) || (imageBReady.value ? 1 : 1))

const effInA  = computed(() => Math.max(0, Math.min(trimInA.value,  sourceFramesA.value - 1)))
const effOutA = computed(() => trimOutA.value < 0 ? sourceFramesA.value : Math.max(effInA.value + 1, Math.min(trimOutA.value, sourceFramesA.value)))
const effInB  = computed(() => Math.max(0, Math.min(trimInB.value,  sourceFramesB.value - 1)))
const effOutB = computed(() => trimOutB.value < 0 ? sourceFramesB.value : Math.max(effInB.value + 1, Math.min(trimOutB.value, sourceFramesB.value)))

const lenA = computed(() => effOutA.value - effInA.value)
const lenB = computed(() => effOutB.value - effInB.value)
const overlap = computed(() => Math.max(1, Math.min(duration.value, lenA.value, lenB.value)))

// -- Source URL resolution (shared with every other timeline surface) --------

function resolveSource(clipPortIdx: number): ClipSource | null {
  const edge = props.edges.find((e: any) =>
    e.target === props.nodeId && e.targetHandle === `input-${clipPortIdx}`)
  if (!edge) return null
  const src = props.nodes.find((n: any) => n.id === edge.source)
  // Crossfade pairs two stills/clips — collapse a frame sequence to a single
  // mid-sequence frame rather than a playable sequence.
  return resolveClipSource(src, { kinetic: 'mid' })
}

const clipA = computed(() => resolveSource(0))
const clipB = computed(() => resolveSource(1))

// -- Media elements ----------------------------------------------------------
//
// HTMLVideoElement.duration and HTMLImageElement.naturalWidth aren't Vue
// reactive properties — Vue won't re-run computeds when they change on
// metadata load. We mirror them into refs that we update from the relevant
// load events, so the rest of the modal can derive timeline state reactively.

const videoA = ref<HTMLVideoElement | null>(null)
const videoB = ref<HTMLVideoElement | null>(null)
const imageA = ref<HTMLImageElement | null>(null)
const imageB = ref<HTMLImageElement | null>(null)

const videoADur = ref(0)
const videoBDur = ref(0)
const imageAReady = ref(false)
const imageBReady = ref(false)

function attachVideoMeta(v: HTMLVideoElement, durRef: { value: number }) {
  v.addEventListener('loadedmetadata', () => {
    durRef.value = v.duration || 0
    setTimeout(refreshCanvasSize, 0)
  })
  v.addEventListener('durationchange', () => {
    durRef.value = v.duration || 0
  })
}
function attachImageReady(img: HTMLImageElement, readyRef: { value: boolean }) {
  img.addEventListener('load', () => {
    readyRef.value = true
    setTimeout(refreshCanvasSize, 0)
  })
}

function ensureSourceMedia() {
  const a = clipA.value, b = clipB.value
  // A
  if (a?.kind === 'video') {
    if (!videoA.value) {
      const v = document.createElement('video')
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous'
      attachVideoMeta(v, videoADur)
      videoA.value = v
    }
    if (videoA.value.src !== new URL(a.url, location.href).href) {
      videoADur.value = 0
      videoA.value.src = a.url
      videoA.value.load()
    }
    imageA.value = null
    imageAReady.value = false
  } else if (a?.kind === 'image') {
    if (!imageA.value) {
      const img = new Image()
      attachImageReady(img, imageAReady)
      imageA.value = img
    }
    if (imageA.value.src !== new URL(a.url, location.href).href) {
      imageAReady.value = false
      imageA.value.src = a.url
    }
    videoA.value = null
    videoADur.value = 0
  } else {
    videoA.value = null; imageA.value = null
    videoADur.value = 0; imageAReady.value = false
  }
  // B
  if (b?.kind === 'video') {
    if (!videoB.value) {
      const v = document.createElement('video')
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous'
      attachVideoMeta(v, videoBDur)
      videoB.value = v
    }
    if (videoB.value.src !== new URL(b.url, location.href).href) {
      videoBDur.value = 0
      videoB.value.src = b.url
      videoB.value.load()
    }
    imageB.value = null
    imageBReady.value = false
  } else if (b?.kind === 'image') {
    if (!imageB.value) {
      const img = new Image()
      attachImageReady(img, imageBReady)
      imageB.value = img
    }
    if (imageB.value.src !== new URL(b.url, location.href).href) {
      imageBReady.value = false
      imageB.value.src = b.url
    }
    videoB.value = null
    videoBDur.value = 0
  } else {
    videoB.value = null; imageB.value = null
    videoBDur.value = 0; imageBReady.value = false
  }
}

watch([clipA, clipB], ensureSourceMedia, { immediate: true })

// -- Curve math --------------------------------------------------------------

function evalCurve(t: number, c: string): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  switch (c) {
    case 'linear':      return t
    case 'ease_in':     return t * t
    case 'ease_out':    return 1 - (1 - t) ** 2
    case 'ease_in_out': return 0.5 - 0.5 * Math.cos(t * Math.PI)
  }
  return t
}

function curvePolyline(c: string, w = 60, h = 40): string {
  const pts: string[] = []
  const N = 24
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const y = h - evalCurve(t, c) * h
    pts.push(`${(t * w).toFixed(1)},${y.toFixed(1)}`)
  }
  return pts.join(' ')
}

// -- Scrub + playback --------------------------------------------------------

// Scrub is normalized over the transition window: 0 = first frame of fade,
// 1 = last frame. Clip A's playhead lands at (clipA.duration − (1−scrub)·d/FPS).
const scrub = ref(0.5)
const isPlaying = ref(false)
let playStart = 0
let playStartScrub = 0

// We preview the **full joined output**, not just the transition window.
// scrub ∈ [0, 1] sweeps from clip A's first frame, through the full A frames,
// into the blended transition, and into clip B's remainder.
//
//                            transition
//   A: ────────────────────────│──┤  (last `d` frames blend down)
//   B:                          ├──│──────────────────────── (first `d` frames blend up)
//                            t_start                     t_end
//
// Output length (in frames): T_a + T_b - d.  All math below is in fractions
// of that total so we can scrub continuously.

interface OutputTimeline {
  totalFrames: number
  tStartFrac: number   // where the transition window begins, as a fraction of total
  tEndFrac: number     // where it ends
  durationA: number    // clip A length in source seconds
  durationB: number
}

const timeline = computed<OutputTimeline | null>(() => {
  const haveA = videoADur.value > 0 || imageAReady.value
  const haveB = videoBDur.value > 0 || imageBReady.value
  if (!haveA || !haveB) return null
  const La = lenA.value
  const Lb = lenB.value
  const d  = overlap.value
  const total = Math.max(1, La + Lb - d)
  return {
    totalFrames: total,
    // Transition window in OUTPUT frames sits at the end of trimmed A.
    tStartFrac: (La - d) / total,
    tEndFrac:    La       / total,
    durationA: La / FPS,
    durationB: Lb / FPS,
  }
})

// scrub is now over the entire output. Convert to clip-local positions.
const inTransition = computed(() => {
  const tl = timeline.value
  if (!tl) return false
  return scrub.value >= tl.tStartFrac && scrub.value < tl.tEndFrac
})

const transitionT = computed(() => {
  const tl = timeline.value
  if (!tl || !inTransition.value) return 0
  return (scrub.value - tl.tStartFrac) / Math.max(1e-6, tl.tEndFrac - tl.tStartFrac)
})

const alpha = computed(() => evalCurve(transitionT.value, curve.value))

const frameIndex = computed(() => {
  const tl = timeline.value
  if (!tl) return 0
  return Math.round(scrub.value * (tl.totalFrames - 1))
})

function togglePlay() {
  if (isPlaying.value) {
    isPlaying.value = false
  } else {
    isPlaying.value = true
    playStart = performance.now()
    playStartScrub = scrub.value
  }
}

// -- Strip drag interactions -------------------------------------------------
//
// The strip body click sets the playhead. Dragging a clip's edge trims it.
// Dragging clip B's body changes the overlap (= crossfade duration).

const stripRef = ref<HTMLDivElement | null>(null)
type DragPart = 'a-in' | 'a-out' | 'b-in' | 'b-out' | 'b-body' | 'playhead'
const draggingPart = ref<DragPart | null>(null)
let dragStartX = 0
let dragStartTrimIn = 0
let dragStartTrimOut = 0
let dragStartDuration = 0

function pxToFrames(px: number): number {
  const tl = timeline.value
  const w = stripRef.value?.clientWidth ?? 1
  if (!tl) return 0
  return (px / w) * tl.totalFrames
}

function startDrag(part: DragPart, e: PointerEvent) {
  e.preventDefault()
  e.stopPropagation()
  draggingPart.value = part
  dragStartX = e.clientX
  dragStartTrimIn = part.endsWith('-in') ? (part.startsWith('a') ? effInA.value : effInB.value) : 0
  dragStartTrimOut = part.endsWith('-out') ? (part.startsWith('a') ? effOutA.value : effOutB.value) : 0
  dragStartDuration = duration.value
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  isPlaying.value = false
}
function onStripPointerMove(e: PointerEvent) {
  if (!draggingPart.value) return
  const df = Math.round(pxToFrames(e.clientX - dragStartX))
  const part = draggingPart.value
  if (part === 'a-in') {
    trimInA.value = Math.max(0, Math.min(dragStartTrimIn + df, effOutA.value - 1))
  } else if (part === 'a-out') {
    const nextOut = Math.max(effInA.value + 1, Math.min(dragStartTrimOut + df, sourceFramesA.value))
    trimOutA.value = nextOut >= sourceFramesA.value ? -1 : nextOut
  } else if (part === 'b-in') {
    trimInB.value = Math.max(0, Math.min(dragStartTrimIn + df, effOutB.value - 1))
  } else if (part === 'b-out') {
    const nextOut = Math.max(effInB.value + 1, Math.min(dragStartTrimOut + df, sourceFramesB.value))
    trimOutB.value = nextOut >= sourceFramesB.value ? -1 : nextOut
  } else if (part === 'b-body') {
    // Dragging clip B left increases the overlap; right shortens it.
    // df positive = B moves right = overlap decreases.
    const nextDuration = Math.max(1, Math.min(dragStartDuration - df, lenA.value, lenB.value))
    duration.value = nextDuration
  } else if (part === 'playhead') {
    const rect = stripRef.value!.getBoundingClientRect()
    scrub.value = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }
}
function onStripPointerUp() {
  draggingPart.value = null
}

function onStripPointerDown(e: PointerEvent) {
  // Click on empty strip space → move playhead. Bar clicks handled separately.
  if (!stripRef.value) return
  if (e.target !== stripRef.value && !(e.target as HTMLElement).classList.contains('strip-bg')) return
  const rect = stripRef.value.getBoundingClientRect()
  scrub.value = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  draggingPart.value = 'playhead'
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  isPlaying.value = false
}

// -- Canvas render -----------------------------------------------------------

const canvasRef = ref<HTMLCanvasElement | null>(null)
const canvasW = ref(720)
const canvasH = ref(405)
let rafId: number | null = null

function srcSize(): { w: number; h: number } | null {
  const a = videoA.value, b = videoB.value, ia = imageA.value, ib = imageB.value
  if (a && a.videoWidth > 0) return { w: a.videoWidth, h: a.videoHeight }
  if (ia && ia.complete && ia.naturalWidth > 0) return { w: ia.naturalWidth, h: ia.naturalHeight }
  if (b && b.videoWidth > 0) return { w: b.videoWidth, h: b.videoHeight }
  if (ib && ib.complete && ib.naturalWidth > 0) return { w: ib.naturalWidth, h: ib.naturalHeight }
  return null
}

function refreshCanvasSize() {
  const s = srcSize()
  if (!s) return
  const max = 960
  const long = Math.max(s.w, s.h)
  const k = long > max ? max / long : 1
  canvasW.value = Math.round(s.w * k)
  canvasH.value = Math.round(s.h * k)
}

function objectContainRect(srcW: number, srcH: number, dstW: number, dstH: number) {
  const sa = srcW / srcH, da = dstW / dstH
  let w: number, h: number
  if (sa > da) { w = dstW; h = dstW / sa }
  else         { h = dstH; w = dstH * sa }
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h }
}

function drawOnce() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  if (canvas.width !== canvasW.value) canvas.width = canvasW.value
  if (canvas.height !== canvasH.value) canvas.height = canvasH.value

  const tl = timeline.value

  // Advance scrub while playing — over the full output duration.
  if (isPlaying.value && tl) {
    const totalSec = tl.totalFrames / FPS
    const elapsed = (performance.now() - playStart) / 1000
    let next = playStartScrub + (elapsed / Math.max(0.05, totalSec))
    if (next >= 1) {
      next = 0
      playStart = performance.now()
      playStartScrub = 0
    }
    scrub.value = next
  }

  // What source time does each clip want to be at right now?
  //
  // We track the scrub in OUTPUT time (a real video timeline). Convert that
  // back to each source clip's currentTime:
  //   • Clip A plays from 0 → its full duration; the last `d` seconds overlap.
  //   • Clip B's playback BEGINS at scrub = tStartFrac and runs to the end.
  const aActive = !!tl && scrub.value < tl.tEndFrac
  const bActive = !!tl && scrub.value >= tl.tStartFrac

  let aTargetSec = 0
  let bTargetSec = 0
  if (tl) {
    const outFrame = scrub.value * (tl.totalFrames - 1)
    // Source frame in clip A = trim_in_a + output frame (until A's region ends)
    const aSrcFrame = effInA.value + outFrame
    aTargetSec = aSrcFrame / FPS
    // Source frame in clip B = trim_in_b + (outFrame - (A_length - overlap))
    const bSrcFrame = effInB.value + (outFrame - (lenA.value - overlap.value))
    bTargetSec = bSrcFrame / FPS
  }

  function syncVideo(v: HTMLVideoElement | null, targetSec: number, active: boolean) {
    if (!v || !(v.duration > 0)) return
    if (!active) {
      // Outside this clip's window — pause and park near a sensible spot
      // (helps the GPU not keep decoding when the clip isn't visible).
      if (!v.paused) v.pause()
      return
    }
    const t = Math.max(0, Math.min(v.duration, targetSec))
    if (isPlaying.value) {
      if (v.paused) {
        try { v.currentTime = t } catch {}
        v.play().catch(() => {})
      } else if (Math.abs(v.currentTime - t) > 0.15) {
        try { v.currentTime = t } catch {}
      }
    } else {
      if (!v.paused) v.pause()
      if (Math.abs(v.currentTime - t) > 0.05) {
        try { v.currentTime = t } catch {}
      }
    }
  }
  syncVideo(videoA.value, aTargetSec, aActive)
  syncVideo(videoB.value, bTargetSec, bActive)

  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Alpha for the blend layer. 0 outside the transition window, evalCurve
  // inside. Outside the window, only one clip is drawn (the other is paused).
  const a = inTransition.value ? alpha.value : (scrub.value >= (tl?.tEndFrac ?? 1) ? 1 : 0)

  // Draw A with (1-a). Skipped entirely when fully past the transition.
  if (aActive) {
    const srcA = (videoA.value && videoA.value.videoWidth > 0)
      ? { el: videoA.value as CanvasImageSource, w: videoA.value.videoWidth, h: videoA.value.videoHeight }
      : (imageA.value && imageA.value.complete && imageA.value.naturalWidth > 0)
        ? { el: imageA.value as CanvasImageSource, w: imageA.value.naturalWidth, h: imageA.value.naturalHeight }
        : null
    if (srcA) {
      ctx.globalAlpha = 1 - a
      const r = objectContainRect(srcA.w, srcA.h, canvas.width, canvas.height)
      try { ctx.drawImage(srcA.el, r.x, r.y, r.w, r.h) } catch {}
    }
  }

  // Draw B with a. Skipped entirely when before the transition.
  if (bActive) {
    const srcB = (videoB.value && videoB.value.videoWidth > 0)
      ? { el: videoB.value as CanvasImageSource, w: videoB.value.videoWidth, h: videoB.value.videoHeight }
      : (imageB.value && imageB.value.complete && imageB.value.naturalWidth > 0)
        ? { el: imageB.value as CanvasImageSource, w: imageB.value.naturalWidth, h: imageB.value.naturalHeight }
        : null
    if (srcB) {
      ctx.globalAlpha = a
      const r = objectContainRect(srcB.w, srcB.h, canvas.width, canvas.height)
      try { ctx.drawImage(srcB.el, r.x, r.y, r.w, r.h) } catch {}
    }
  }

  ctx.globalAlpha = 1
}

function loop() {
  drawOnce()
  rafId = requestAnimationFrame(loop)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
  else if (e.key === ' ') { e.preventDefault(); togglePlay() }
}

onMounted(() => {
  loop()
  setTimeout(refreshCanvasSize, 200)
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('pointermove', onStripPointerMove)
  window.addEventListener('pointerup', onStripPointerUp)
})
onUnmounted(() => {
  if (rafId != null) cancelAnimationFrame(rafId)
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('pointermove', onStripPointerMove)
  window.removeEventListener('pointerup', onStripPointerUp)
  for (const v of [videoA.value, videoB.value]) {
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load() } catch {} }
  }
})

const hasBothSources = computed(() => !!clipA.value && !!clipB.value)
</script>

<template>
  <div
    class="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
    @click.self="emit('close')"
  >
    <div class="w-full h-full max-w-[1200px] max-h-[820px] bg-[#0a0a0a] rounded-xl border border-white/10 shadow-2xl flex flex-col text-white/85 overflow-hidden">

      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
        <div>
          <h2 class="text-sm font-semibold tracking-tight">Crossfade</h2>
          <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mt-0.5">
            Clip A → Clip B
          </div>
        </div>
        <button
          class="flex items-center justify-center size-7 rounded hover:bg-white/10 transition-colors cursor-pointer"
          title="Close (Esc)"
          @click="emit('close')"
        >
          <X class="size-4" />
        </button>
      </div>

      <!-- Preview canvas -->
      <div class="flex-1 relative flex items-center justify-center overflow-hidden bg-[#080808]">
        <canvas
          v-if="hasBothSources"
          ref="canvasRef"
          class="max-w-full max-h-full object-contain ring-1 ring-white/5 rounded bg-black"
          :style="{ aspectRatio: `${canvasW}/${canvasH}` }"
        />
        <div v-else class="text-xs text-white/40 italic">
          Connect both Clip A and Clip B to see a preview.
        </div>

        <!-- Frame counter -->
        <div class="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-white/40 tabular-nums">
          <template v-if="timeline">
            Frame {{ frameIndex }} / {{ timeline.totalFrames - 1 }}
            <span class="ml-2" :class="inTransition ? 'text-white/70' : 'text-white/30'">
              {{ inTransition ? `transition · α = ${alpha.toFixed(2)}` : (scrub >= timeline.tEndFrac ? 'Clip B' : 'Clip A') }}
            </span>
          </template>
          <template v-else>
            (waiting for clips to load)
          </template>
          <span v-if="isPlaying" class="ml-1 text-white/70">▶</span>
        </div>
      </div>

      <!-- Timeline editor: two lanes with drag-to-trim handles and overlap drag -->
      <div class="px-6 py-3 border-t border-white/10 shrink-0">
        <div class="flex items-center gap-3 mb-2">
          <button
            class="flex items-center justify-center size-8 rounded-full bg-white/15 hover:bg-white/20 text-white/70 transition-colors cursor-pointer"
            :title="isPlaying ? 'Pause (Space)' : 'Play (Space)'"
            @click="togglePlay"
          >
            <Pause v-if="isPlaying" class="size-4" />
            <Play v-else class="size-4 translate-x-px" />
          </button>
          <span class="text-xs text-white/50 tabular-nums">
            {{ timeline ? `Frame ${frameIndex} / ${timeline.totalFrames - 1}` : '—' }}
          </span>
          <span class="text-xs text-white/30 ml-auto tabular-nums">
            A {{ lenA }}f · overlap {{ overlap }}f · B {{ lenB }}f
          </span>
          <span
            v-if="duration > lenA || duration > lenB"
            class="text-[10px] text-amber-300/90 px-2 py-0.5 rounded bg-amber-500/10"
            :title="`Crossfade is being clamped to ${overlap} frames — one or both clips are shorter than your ${duration}f setting.`"
          >
            duration clamped to {{ overlap }}f
          </span>
        </div>

        <!-- Strip body. Two lanes (A on top, B below), overlap shaded, playhead vertical line. -->
        <div
          v-if="timeline"
          ref="stripRef"
          class="relative h-16 bg-[#0a0a0a] rounded border border-white/5 select-none touch-none overflow-hidden cursor-pointer"
          @pointerdown="onStripPointerDown"
        >
          <!-- Overlap shading spans both lanes -->
          <div
            class="absolute inset-y-0 bg-white/15"
            :style="{
              left: ((lenA - overlap) / timeline.totalFrames * 100) + '%',
              width: (overlap / timeline.totalFrames * 100) + '%'
            }"
          />

          <!-- Lane A (top) -->
          <div
            class="absolute h-6 top-1 rounded bg-white/70 hover:bg-white/85 transition-colors"
            :class="[draggingPart === 'a-body' ? 'ring-2 ring-white/40' : '']"
            :style="{ left: '0%', width: (lenA / timeline.totalFrames * 100) + '%' }"
          >
            <div class="px-2 h-full flex items-center text-[10px] text-black/85 font-medium pointer-events-none truncate">
              Clip A · {{ lenA }}f
            </div>
            <!-- Left trim handle: drag to advance trim_in_a -->
            <div
              class="absolute left-0 top-0 bottom-0 w-1.5 bg-white/40 cursor-ew-resize"
              title="Trim start of clip A"
              @pointerdown="(e) => startDrag('a-in', e)"
            />
            <!-- Right trim handle: drag to pull trim_out_a back -->
            <div
              class="absolute right-0 top-0 bottom-0 w-1.5 bg-white/40 cursor-ew-resize"
              title="Trim end of clip A"
              @pointerdown="(e) => startDrag('a-out', e)"
            />
          </div>

          <!-- Lane B (bottom). Body-drag changes overlap. -->
          <div
            class="absolute h-6 top-9 rounded bg-white/55 hover:bg-white/70 transition-colors cursor-grab"
            :class="[draggingPart === 'b-body' ? 'ring-2 ring-white/40 cursor-grabbing' : '']"
            :style="{
              left: ((lenA - overlap) / timeline.totalFrames * 100) + '%',
              width: (lenB / timeline.totalFrames * 100) + '%'
            }"
            @pointerdown="(e) => startDrag('b-body', e)"
          >
            <div class="px-2 h-full flex items-center text-[10px] text-black/85 font-medium pointer-events-none truncate">
              Clip B · {{ lenB }}f
            </div>
            <div
              class="absolute left-0 top-0 bottom-0 w-1.5 bg-white/40 cursor-ew-resize"
              title="Trim start of clip B"
              @pointerdown.stop="(e) => startDrag('b-in', e)"
            />
            <div
              class="absolute right-0 top-0 bottom-0 w-1.5 bg-white/40 cursor-ew-resize"
              title="Trim end of clip B"
              @pointerdown.stop="(e) => startDrag('b-out', e)"
            />
          </div>

          <!-- Playhead -->
          <div
            class="absolute top-0 bottom-0 w-px bg-yellow-400 pointer-events-none"
            :style="{ left: (scrub * 100) + '%' }"
          >
            <div class="absolute -top-px -left-1 w-2 h-2 bg-yellow-400 rotate-45" />
          </div>
        </div>

        <div v-else class="h-16 grid place-items-center text-xs text-white/30 italic">
          Waiting for clips to load…
        </div>
      </div>

      <!-- Controls: Duration + Curve picker -->
      <div class="grid grid-cols-[auto_1fr] gap-6 px-6 py-4 border-t border-white/10 shrink-0">
        <!-- Duration -->
        <div class="flex flex-col gap-1.5 w-44">
          <label class="text-[10px] uppercase tracking-[0.12em] text-white/40">Duration</label>
          <div class="flex items-center gap-2">
            <input
              type="number" min="1" :value="duration"
              class="w-20 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 outline-none text-white/90 text-sm tabular-nums"
              @input="duration = parseInt(($event.target as HTMLInputElement).value) || 1"
            />
            <span class="text-[10px] text-white/40 tabular-nums">
              frames<br>≈ {{ (duration / FPS).toFixed(2) }}s
            </span>
          </div>
          <!-- label blank: the "Duration" section header above already names it. -->
          <StudioSlider
            label="" :min="1" :max="120" :step="1" :bindable="false"
            :model-value="duration" @update:model-value="(v) => duration = Math.max(1, Math.round(v))"
          />
        </div>

        <!-- Curve picker -->
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] uppercase tracking-[0.12em] text-white/40">Curve</label>
          <div class="flex gap-2">
            <button
              v-for="c in CURVES"
              :key="c"
              class="flex flex-col items-center p-2 rounded cursor-pointer transition-colors group"
              :class="curve === c
                ? 'bg-white/15 ring-1 ring-white/30'
                : 'bg-white/[0.04] hover:bg-white/[0.08] ring-1 ring-transparent'"
              @click="curve = c"
            >
              <svg width="60" height="40" viewBox="0 0 60 40" class="overflow-visible">
                <!-- Grid -->
                <line x1="0" y1="40" x2="60" y2="40" stroke="white" stroke-opacity="0.1" />
                <line x1="0" y1="0" x2="0" y2="40" stroke="white" stroke-opacity="0.1" />
                <!-- Curve -->
                <polyline
                  :points="curvePolyline(c)"
                  fill="none"
                  :stroke="curve === c ? '#ffffff' : 'rgba(255,255,255,0.55)'"
                  stroke-width="2"
                  class="transition-colors"
                />
                <!-- Playhead dot — shows current alpha on the active curve -->
                <circle
                  v-if="curve === c"
                  :cx="scrub * 60"
                  :cy="40 - evalCurve(scrub, c) * 40"
                  r="3"
                  fill="#ffffff"
                />
              </svg>
              <span
                class="text-[10px] mt-1 capitalize tracking-tight transition-colors"
                :class="curve === c ? 'text-white' : 'text-white/60'"
              >{{ c.replace('_', ' ') }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
