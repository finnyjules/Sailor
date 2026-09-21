<script setup lang="ts">
import { ref, computed, inject, onMounted, onUnmounted, watch, nextTick, type Ref } from 'vue'
import {
  X, Play, Pause, SkipBack, SkipForward, ChevronsLeft, ChevronsRight, FoldHorizontal,
  RotateCw, Undo2, Redo2, Plus, Trash2, Scissors, Volume2, VolumeX, Eye, EyeOff,
  Lock, Unlock, Film, Music, ImageIcon, Type, Cpu, Diamond, Magnet,
} from 'lucide-vue-next'
import { useTimelineStore } from '~/composables/useTimelineStore'
import { useAssetLibrary } from '~/composables/useAssetLibrary'
import { usePlaybackEngine } from '~/composables/usePlaybackEngine'
import { usePlaybackEngineGL, webglPreviewSupported } from '~/composables/usePlaybackEngineGL'
import { useLocalSettings } from '~/composables/useLocalSettings'
import { useClipPreview } from '~/composables/useClipPreview'
import { ensureMotionBake } from '~/lib/engine/motionClipBake'
import { ensureSpaceTypeClipBake } from '~/lib/engine/spaceTypeClipBake'
import { spaceTypeEngineAvailable } from '~/lib/engine/spaceTypeEnginePool'
import { ensureMotionFonts } from '~/composables/useTemplateFonts'
import { ensureTimelineMix } from '~/lib/engine/audio/mixdown'
import type { Clip, Track, BlendMode, MotionClip, SpaceTypeClip, Transition, TransitionKind, EditState } from '~~/shared/timeline/types'
import { computeTotalFrames } from '~~/shared/timeline/types'
import { interpolateClipAt } from '~~/shared/timeline/interpolate'
import { resolveClipSource } from '~~/shared/timeline/resolveClipSource'
import { snapGroupDelta, computeGroupResize, neighbourGaps, type Span, type ResizeMember } from '~~/shared/timeline/groupEdit'
import { settleOverlaps } from '~~/shared/timeline/placement'
import { computeRippleEdits, applyRippleEdits } from '~~/shared/timeline/ripple'
import { collectProjectMediaFilenames } from '~/lib/timeline/projectMedia'
import type { SpaceTypeState } from '~/lib/spacetype/state'
import MotionClipInspector from '~/components/vue-canvas/timeline/MotionClipInspector.vue'
import SpaceTypeClipInspector from '~/components/vue-canvas/timeline/SpaceTypeClipInspector.vue'
import KeyframeDock from '~/components/vue-canvas/timeline/KeyframeDock.vue'
import TimelineContextMenu, { type MenuItem } from '~/components/vue-canvas/timeline/TimelineContextMenu.vue'

const props = defineProps<{
  nodeId: string
  nodes: any[]
  edges: any[]
}>()

const emit = defineEmits<{ close: [] }>()

const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay',
  'soft_light', 'hard_light', 'difference', 'lighten', 'darken', 'add']

const TRACK_COLORS = [
  { bar: 'bg-white/70', edge: 'bg-white/50', ring: 'ring-white/40', text: 'text-white/70' },
  { bar: 'bg-white/55', edge: 'bg-white/45', ring: 'ring-white/35', text: 'text-white/65' },
  { bar: 'bg-white/45', edge: 'bg-white/40', ring: 'ring-white/30', text: 'text-white/60' },
  { bar: 'bg-amber-500/70', edge: 'bg-amber-300', ring: 'ring-amber-400', text: 'text-amber-300' },
  { bar: 'bg-rose-500/70', edge: 'bg-rose-300', ring: 'ring-rose-400', text: 'text-rose-300' },
  { bar: 'bg-white/35', edge: 'bg-white/30', ring: 'ring-white/25', text: 'text-white/55' },
]

function trackColor(idx: number) {
  return TRACK_COLORS[idx % TRACK_COLORS.length]!
}

// -- Store --

const store = useTimelineStore()
const { assets: assetsList, fetchAssets, importAsset, fetchInputFiles, getAsset, assetUrl: getAssetUrl } = useAssetLibrary()
const { getThumbs, getWaveform, thumbVersion, waveVersion } = useClipPreview()

const timeline = computed(() => props.nodes.find((n: any) => n.id === props.nodeId))

// Edit state is persisted in `node.data.properties` (a free-form dict).
// We keep the existing 4-port + flat-widget Timeline schema untouched.
function getValue(name: string): any {
  const props_bag = timeline.value?.data?.properties
  if (!props_bag) return undefined
  return props_bag[name]
}
function setValue(name: string, v: any) {
  const node = timeline.value
  if (!node) return
  if (!node.data.properties) node.data.properties = {}
  node.data.properties[name] = v
}

onMounted(async () => {
  store.bind(props.nodeId, getValue, setValue)
  await fetchAssets()
  await loadInputFiles()
  engine.start()
  window.addEventListener('keydown', handleKeydown, true)
  window.addEventListener('keydown', onKeyToggle)
  window.addEventListener('keyup', onKeyToggle)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointermove', onGlobalPointerMove)
  window.addEventListener('pointerup', onGlobalPointerUp)
  window.addEventListener('resize', () => { measureStrip(); clampScroll() })
  nextTick(() => {
    measureStrip()
    // First-load zoom: aim for ~10 seconds of timeline visible by default.
    // For an empty timeline (totalFrames <= 1) the "fit" math degenerates,
    // so just pick a comfortable px-per-frame instead.
    const fps = store.fps.value
    const clipsExist = store.totalFrames.value > 1
    if (clipsExist) {
      const fitPpf = stripWidth.value / store.totalFrames.value
      // Don't go past 8 px/frame on auto-fit — keeps short clips readable
      // but doesn't fly to MAX_PX_PER_FRAME for tiny edits.
      pxPerFrame.value = Math.max(0.5, Math.min(8, fitPpf))
    } else {
      // ~10 seconds visible at typical strip width (~900px after the headers).
      const stripPx = Math.max(400, stripWidth.value)
      pxPerFrame.value = Math.max(0.5, Math.min(8, stripPx / (10 * fps)))
    }
  })
})

onUnmounted(() => {
  store.pause()
  engine.destroy()
  store.unbind()
  window.removeEventListener('keydown', handleKeydown, true)
  window.removeEventListener('keydown', onKeyToggle)
  window.removeEventListener('keyup', onKeyToggle)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointermove', onGlobalPointerMove)
  window.removeEventListener('pointerup', onGlobalPointerUp)
  window.removeEventListener('resize', measureStrip)
})

// -- Input files browser --

const inputFiles = ref<Array<{ filename: string; path: string }>>([])
async function loadInputFiles() {
  const items = await fetchInputFiles()
  inputFiles.value = items.map(i => ({ filename: i.filename, path: i.path }))
}

// Project scope: the whole input/ dir accumulates every file ever generated,
// so the Project tab shows only media THIS project's graphs reference (any
// canvas, live or serialized). "Show all" reveals the rest on demand.
const projectDoc = inject<Ref<{ canvases?: { workflow?: any }[] } | null> | null>('projectDoc', null)
const projectMediaFiles = computed<Set<string>>(() =>
  collectProjectMediaFilenames(projectDoc?.value ?? null, props.nodes))
const projectInputFiles = computed(() =>
  inputFiles.value.filter(f => projectMediaFiles.value.has(f.filename)))
const otherFilesCount = computed(() => inputFiles.value.length - projectInputFiles.value.length)
const showAllFiles = ref(false)
const visibleInputFiles = computed(() =>
  showAllFiles.value ? inputFiles.value : projectInputFiles.value)

async function addFileToTimeline(file: { filename: string; path: string }) {
  const asset = await importAsset(file.path)
  if (!asset) return
  const fps = store.fps.value
  const lengthFrames = asset.duration_sec ? Math.round(asset.duration_sec * fps) : fps * 5

  const trackKind = asset.kind === 'audio' ? 'audio' : 'video'
  let targetTrack = store.state.value.tracks.find(t => t.kind === trackKind && !t.locked)
  if (!targetTrack) {
    store.addTrack(trackKind)
    targetTrack = store.state.value.tracks[store.state.value.tracks.length - 1]
  }

  const maxEnd = targetTrack!.clips.reduce((m, c) => Math.max(m, c.start_frame + c.length), 0)

  const clip: Clip = {
    id: crypto.randomUUID(),
    kind: asset.kind as any,
    asset_id: asset.id,
    start_frame: maxEnd,
    in_frame: 0,
    length: lengthFrames,
    x: 0, y: 0, rotation: 0, scale: 1,
    opacity: 1, blend: 'normal',
    fade_in: 0, fade_out: 0,
    volume: 1,
  } as Clip

  store.addClip(targetTrack!.id, clip)
}

// Add a Kinetic Text motion clip at the playhead on the first video track.
function addKineticText() {
  let targetTrack = store.state.value.tracks.find(t => t.kind === 'video' && !t.locked)
  if (!targetTrack) {
    store.addTrack('video')
    targetTrack = store.state.value.tracks[store.state.value.tracks.length - 1]
  }
  store.addMotionClip(targetTrack!.id, store.playheadFrame.value)
}

// -- Playback engine --

const canvasRef = ref<HTMLCanvasElement | null>(null)

// Resolve a clip to a playable preview source URL. Asset clips look up the
// imported asset; workflow clips walk back through the graph wiring to find
// the upstream file (LoadVideo / LoadImage). For workflow clips with no
// resolvable source (e.g. wired to a processing node), the preview shows
// nothing until the graph is executed.
function resolveClipPreview(clip: Clip): { url: string; kind: 'video' | 'image' | 'sequence'; urls?: string[] } | null {
  if (clip.kind === 'video' || clip.kind === 'image') {
    const asset = getAsset((clip as any).asset_id)
    if (!asset) return null
    return { url: getAssetUrl(asset), kind: clip.kind }
  }
  if (clip.kind === 'workflow') {
    const portIdx = (clip as any).port_index as number
    const binding = portBindings.value.find(b => b.port_index === portIdx)
    if (!binding) return null
    const src = props.nodes.find((n: any) => n.id === binding.upstream_id)
    if (!src) return null
    return resolveClipSource(src)
  }
  return null
}

function resolveAudioUrl(clip: Clip): string | null {
  if (clip.kind !== 'audio') return null
  const asset = getAsset((clip as any).asset_id)
  return asset ? getAssetUrl(asset) : null
}

// Pull the raw input/ filename out of a source URL (resolveClipSource returns
// /view?filename=…&type=input). The export payload needs filenames, not URLs —
// the backend resolves a relative filename against its input directory.
function inputFilenameFromUrl(url: string): string | null {
  if (!url) return null
  try {
    const f = new URL(url, window.location.origin).searchParams.get('filename')
    if (f) return f
  } catch { /* not a parseable URL — fall through */ }
  // Bare filename (no query, no scheme): usable as-is.
  return (!/[?#]/.test(url) && !/^https?:/i.test(url)) ? url : null
}

// WebGL preview engine — DEFAULT when WebGL2 is available (Slice 0 promotion).
// Escape hatch: localStorage.setItem('sailor:Engine.WebGLPreview', 'false')
// forces the legacy Canvas2D engine.
const { getLocalSetting, setLocalSetting } = useLocalSettings()
const wantGl = getLocalSetting('Engine.WebGLPreview') !== 'false'
const useGl = wantGl && webglPreviewSupported()
if (wantGl && !useGl) console.warn('TimelineEditor: WebGL2 unavailable — Canvas2D fallback')
const engine = useGl
  ? usePlaybackEngineGL(canvasRef, store.state, store.playhead, store.isPlaying, resolveClipPreview, resolveAudioUrl)
  : usePlaybackEngine(canvasRef, store.state, store.playhead, store.isPlaying, resolveClipPreview)

// Tick playhead in rAF
let playRafId: number | null = null
function playLoop() {
  store.tickPlayhead()
  playRafId = requestAnimationFrame(playLoop)
}
watch(store.isPlaying, (playing) => {
  if (playing) {
    if (playRafId === null) playLoop()
  } else {
    if (playRafId !== null) {
      cancelAnimationFrame(playRafId)
      playRafId = null
    }
  }
})
onUnmounted(() => { if (playRafId !== null) cancelAnimationFrame(playRafId) })

// -- Strip geometry --
//
// The timeline strip uses two reactive values to map frame ↔ pixel:
//   pxPerFrame  — current zoom level
//   scrollX     — pixels scrolled from frame 0
//
// Coordinate model: a frame F sits at screen-x  = F * pxPerFrame - scrollX
//                   within the strip's local space.
// Fit-to-width and 1:1 zoom are derived; Cmd/Ctrl + wheel zooms under the
// cursor (keeps the frame under the cursor anchored).

const stripRef = ref<HTMLDivElement | null>(null)
const stripWidth = ref(800)
function measureStrip() {
  if (stripRef.value) {
    const newW = stripRef.value.clientWidth
    if (stripWidth.value !== newW) stripWidth.value = newW
  }
}

const TRACK_HEIGHT = 56  // taller so thumbnails/waveforms read clearly
const TRACK_GAP = 2
const RULER_HEIGHT = 22

const MIN_PX_PER_FRAME = 0.05   // very zoomed out
const MAX_PX_PER_FRAME = 60     // very zoomed in (60 px/frame at 30fps = 2px/ms)

const pxPerFrame = ref(4)       // default: 4px per frame ≈ 120 px/sec at 30fps
const scrollX = ref(0)

function framesToPx(frames: number): number {
  return frames * pxPerFrame.value - scrollX.value
}
function pxToFrames(px: number): number {
  return (px + scrollX.value) / pxPerFrame.value
}

function clampScroll() {
  const total = store.totalFrames.value
  const contentW = Math.max(0, total * pxPerFrame.value)
  const maxScroll = Math.max(0, contentW - stripWidth.value + 80) // 80px right padding
  if (scrollX.value < 0) scrollX.value = 0
  if (scrollX.value > maxScroll) scrollX.value = maxScroll
}

function setZoom(newPpf: number, anchorScreenX: number | null = null) {
  const clamped = Math.max(MIN_PX_PER_FRAME, Math.min(MAX_PX_PER_FRAME, newPpf))
  if (anchorScreenX == null) {
    pxPerFrame.value = clamped
  } else {
    // Keep the frame at the cursor anchored.
    const frameAtCursor = pxToFrames(anchorScreenX)
    pxPerFrame.value = clamped
    scrollX.value = frameAtCursor * pxPerFrame.value - anchorScreenX
  }
  clampScroll()
}

function zoomFit() {
  const total = store.totalFrames.value
  if (total <= 0) return
  pxPerFrame.value = Math.max(MIN_PX_PER_FRAME, stripWidth.value / total)
  scrollX.value = 0
}

function zoomOneToOne() {
  // 1 frame = 1 pixel
  pxPerFrame.value = 1
  // Keep playhead centered if possible
  const target = store.playheadFrame.value * pxPerFrame.value - stripWidth.value / 2
  scrollX.value = Math.max(0, target)
  clampScroll()
}

function zoomIn(anchor?: number) {
  setZoom(pxPerFrame.value * 1.5, anchor ?? null)
}
function zoomOut(anchor?: number) {
  setZoom(pxPerFrame.value / 1.5, anchor ?? null)
}

function onStripWheel(e: WheelEvent) {
  // Cmd/Ctrl + wheel = zoom; Shift + wheel = pan; default = pan vertically (parent)
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    const rect = stripRef.value?.getBoundingClientRect()
    const anchor = rect ? e.clientX - rect.left : null
    const factor = Math.exp(-e.deltaY * 0.0015)
    setZoom(pxPerFrame.value * factor, anchor)
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    e.preventDefault()
    scrollX.value += (e.deltaX !== 0 ? e.deltaX : e.deltaY)
    clampScroll()
  }
}

// Auto-scroll playhead into view during playback.
watch(store.playheadFrame, (frame) => {
  if (!store.isPlaying.value) return
  const x = framesToPx(frame)
  const margin = 80
  if (x < margin) {
    scrollX.value = Math.max(0, frame * pxPerFrame.value - margin)
  } else if (x > stripWidth.value - margin) {
    scrollX.value = frame * pxPerFrame.value - (stripWidth.value - margin)
    clampScroll()
  }
})

// -- Strip ticks --
//
// Only generate ticks for the visible frame range. Step size is chosen so
// labels never crowd: aim for one major tick every ~80px.

const visibleFrameRange = computed(() => {
  const start = Math.max(0, Math.floor(pxToFrames(0)))
  const end = Math.ceil(pxToFrames(stripWidth.value))
  return { start, end }
})

// Step is chosen in SECONDS (not frames) so labels are always tidy.
// Frame step is derived from this and clamped to >= 1 so we never iterate
// fractional frames.
const tickStepSec = computed(() => {
  const pxPerSec = pxPerFrame.value * store.fps.value
  // Targets ~80px between major ticks.
  const targetSec = 80 / Math.max(0.01, pxPerSec)
  const niceSteps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600]
  for (const s of niceSteps) if (s >= targetSec) return s
  return niceSteps[niceSteps.length - 1]!
})

const ticks = computed<{ frame: number; major: boolean; label: string }[]>(() => {
  const { start, end } = visibleFrameRange.value
  const fps = store.fps.value
  const stepSec = tickStepSec.value
  const majorFrame = Math.max(1, Math.round(stepSec * fps))
  const minorFrame = Math.max(1, Math.round(majorFrame / 5))
  const out: { frame: number; major: boolean; label: string }[] = []
  const first = Math.floor(start / minorFrame) * minorFrame
  for (let f = first; f <= end; f += minorFrame) {
    const major = (f % majorFrame) === 0
    let label = ''
    if (major) {
      const sec = f / fps
      const m = Math.floor(sec / 60)
      const s = sec - m * 60
      // Precision: use 1 decimal when stepSec < 1, 0 otherwise.
      const prec = stepSec < 1 ? 1 : 0
      const sStr = s.toFixed(prec)
      label = m > 0
        ? `${m}:${sStr.padStart(prec ? 4 : 2, '0')}`
        : (prec > 0 ? `${sStr}s` : `${sStr}s`)
    }
    out.push({ frame: f, major, label })
  }
  return out
})

// -- Track height + reorder --

const MIN_TRACK_HEIGHT = 32
const MAX_TRACK_HEIGHT = 160

function trackHeight(track: Track): number {
  return Math.max(MIN_TRACK_HEIGHT, Math.min(MAX_TRACK_HEIGHT, track.height ?? TRACK_HEIGHT))
}

// Resize: drag the bottom-edge handle of a track header.
const resizingTrackId = ref<string | null>(null)
let resizeStartY = 0
let resizeStartHeight = 0

function onTrackResizeStart(trackId: string, e: PointerEvent) {
  e.preventDefault()
  e.stopPropagation()
  const track = store.state.value.tracks.find(t => t.id === trackId)
  if (!track) return
  store.beginGesture()
  resizingTrackId.value = trackId
  resizeStartY = e.clientY
  resizeStartHeight = trackHeight(track)
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onTrackResizeMove(e: PointerEvent) {
  if (!resizingTrackId.value) return
  const dy = e.clientY - resizeStartY
  const newH = Math.max(MIN_TRACK_HEIGHT, Math.min(MAX_TRACK_HEIGHT, resizeStartHeight + dy))
  const id = resizingTrackId.value
  store.mutate(s => {
    const t = s.tracks.find(t2 => t2.id === id)
    if (t) t.height = newH
  })
}

function onTrackResizeEnd() {
  resizingTrackId.value = null
}

// Reorder: drag a track header up/down to swap with neighbours.
const reorderingTrackId = ref<string | null>(null)
let reorderStartY = 0
let reorderStartIndex = 0

function onTrackReorderStart(trackId: string, e: PointerEvent) {
  // Don't start reorder from inside the resize handle.
  const target = e.target as HTMLElement
  if (target?.dataset?.role === 'resize') return
  e.preventDefault()
  store.beginGesture()
  reorderingTrackId.value = trackId
  reorderStartY = e.clientY
  reorderStartIndex = store.state.value.tracks.findIndex(t => t.id === trackId)
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onTrackReorderMove(e: PointerEvent) {
  if (!reorderingTrackId.value) return
  const dy = e.clientY - reorderStartY
  const avgH = TRACK_HEIGHT + TRACK_GAP
  const indexDelta = Math.round(dy / avgH)
  const targetIdx = Math.max(0, Math.min(
    store.state.value.tracks.length - 1,
    reorderStartIndex + indexDelta
  ))
  const currentIdx = store.state.value.tracks.findIndex(t => t.id === reorderingTrackId.value)
  if (currentIdx === targetIdx) return
  store.mutate(s => {
    const idx = s.tracks.findIndex(t => t.id === reorderingTrackId.value)
    if (idx < 0) return
    const [t] = s.tracks.splice(idx, 1)
    s.tracks.splice(targetIdx, 0, t!)
  })
}

function onTrackReorderEnd() {
  reorderingTrackId.value = null
}

// Combined pointer-move/up listeners for both interactions.
function onGlobalPointerMove(e: PointerEvent) {
  if (resizingTrackId.value) onTrackResizeMove(e)
  if (reorderingTrackId.value) onTrackReorderMove(e)
}
function onGlobalPointerUp() {
  if (resizingTrackId.value) onTrackResizeEnd()
  if (reorderingTrackId.value) onTrackReorderEnd()
  store.endGesture()
}

// -- Multi-select (clip selection set) --
//
// `selectedClipIds` is the full set. `store.selectedClipId` mirrors the
// "primary" selection (last-clicked) for the right-hand Inspector.

const selectedClipIds = ref<Set<string>>(new Set())

function selectOnly(clipId: string) {
  selectedClipIds.value = new Set([clipId])
  store.selectedClipId.value = clipId
}

function toggleSelect(clipId: string) {
  const s = new Set(selectedClipIds.value)
  if (s.has(clipId)) { s.delete(clipId) } else { s.add(clipId) }
  selectedClipIds.value = s
  // Keep primary selection on the most-recently toggled-in clip
  store.selectedClipId.value = s.has(clipId) ? clipId : (s.size ? [...s][s.size - 1]! : null)
}

function clearSelection() {
  selectedClipIds.value = new Set()
  store.selectedClipId.value = null
}

function onClipClick(clipId: string, e: MouseEvent) {
  if (e.shiftKey || e.metaKey || e.ctrlKey) {
    toggleSelect(clipId)
  } else {
    selectOnly(clipId)
  }
}

// -- Drag on clips + snapping --
//
// Snap targets (in frames):
//   • all clip start_frame and (start_frame + length) on other tracks/clips
//   • playhead
//   • frame 0
//   • major ruler ticks
// Threshold is 8px in screen space, so it auto-scales with zoom.

const SNAP_PX = 8

// Snapping toggle (persisted). Alt/Option held during a drag inverts it
// (NLE convention: snap on → Alt frees; snap off → Alt snaps).
const snapEnabled = ref(getLocalSetting('Timeline.Snap') !== 'false')
function toggleSnap() {
  snapEnabled.value = !snapEnabled.value
  setLocalSetting('Timeline.Snap', String(snapEnabled.value))
}

// Ripple: when on, trimming or deleting slides the later clips on that track
// so no gap or overlap is left. Off by default — it moves clips you didn't touch.
const rippleEnabled = ref(getLocalSetting('Timeline.Ripple') === 'true')
function toggleRipple() {
  rippleEnabled.value = !rippleEnabled.value
  setLocalSetting('Timeline.Ripple', String(rippleEnabled.value))
}
const altHeld = ref(false)
function onKeyToggle(e: KeyboardEvent) { altHeld.value = e.altKey }

const drag = ref<null | {
  clipId: string
  trackId: string
  mode: 'move' | 'resize-right' | 'resize-left' | 'playhead'
  startMouseX: number
  startStart: number
  startLength: number
  startIn: number
  /** Track the clip sat on when the drag began (trackId follows cross-track moves). */
  originTrackId: string
}>(null)

// Active snap target visualised as a vertical guideline during drag.
const snapGuideFrame = ref<number | null>(null)

function buildSnapTargets(exclude: ReadonlySet<string>): number[] {
  const targets: number[] = [0, store.playheadFrame.value]
  for (const track of store.state.value.tracks) {
    for (const clip of track.clips) {
      if (exclude.has(clip.id)) continue
      targets.push(clip.start_frame)
      targets.push(clip.start_frame + clip.length)
    }
  }
  // Major ticks within the visible range — gives users a "stick to second" feel.
  const stepFrames = Math.max(1, Math.round(tickStepSec.value * store.fps.value))
  const { start, end } = visibleFrameRange.value
  const first = Math.floor(start / stepFrames) * stepFrames
  for (let f = first; f <= end; f += stepFrames) targets.push(f)
  return targets
}

function snapFrame(rawFrame: number, exclude: ReadonlySet<string>): number {
  const active = snapEnabled.value !== altHeld.value   // XOR: Alt inverts
  if (!active) { snapGuideFrame.value = null; return rawFrame }
  const targets = buildSnapTargets(exclude)
  const thresholdFrames = SNAP_PX / pxPerFrame.value
  let best = rawFrame
  let bestDist = thresholdFrames
  for (const t of targets) {
    const d = Math.abs(t - rawFrame)
    if (d < bestDist) { bestDist = d; best = t }
  }
  snapGuideFrame.value = best !== rawFrame ? best : null
  return best
}

/** The clips that move or trim together in the current drag. */
function draggingIds(): Set<string> {
  if (dragResizeMembers) return new Set(dragResizeMembers.map(m => m.id))
  if (dragGroupStarts && dragGroupStarts.size > 1) return new Set(dragGroupStarts.keys())
  return new Set(drag.value ? [drag.value.clipId] : [])
}

// Snapshot of clip start-frames at drag-start for bulk-move support.
let dragGroupStarts: Map<string, number> | null = null

// Snapshot of every clip taking part in a trim, taken at drag-start.
let dragResizeMembers: ResizeMember[] | null = null

function snapshotResizeMembers(primaryId: string): ResizeMember[] {
  const ids = selectedClipIds.value.size > 1 && selectedClipIds.value.has(primaryId)
    ? new Set(selectedClipIds.value) : new Set([primaryId])
  const out: ResizeMember[] = []
  for (const track of store.state.value.tracks) {
    if (track.locked) continue
    for (const c of track.clips) {
      if (!ids.has(c.id)) continue
      out.push({
        id: c.id, start_frame: c.start_frame, in_frame: c.in_frame ?? 0, length: c.length,
        anchored: c.kind === 'video' || c.kind === 'audio',
        sourceFrames: clipSourceFrames(c), speed: c.speed ?? 1,
        ...(() => {
          const g = neighbourGaps(track.clips, c.id, ids)
          // With ripple on, the neighbours get pushed, so they are not a limit.
          return rippleEnabled.value ? { gapBefore: null, gapAfter: null } : g
        })(),
      })
    }
  }
  return out
}

// Which track lane is under this clientY? (null = ruler or below the lanes)
function trackIndexAtY(clientY: number): number | null {
  const rect = stripRef.value?.getBoundingClientRect()
  if (!rect) return null
  let y = clientY - rect.top - RULER_HEIGHT
  if (y < 0) return null
  const tracks = store.state.value.tracks
  for (let i = 0; i < tracks.length; i++) {
    const h = trackHeight(tracks[i]!)
    if (y < h) return i
    y -= h
  }
  return null
}

// Highlight for the lane a dragged clip would land on.
const moveTargetTrackId = ref<string | null>(null)

// Known source length in frames for asset-backed clips (null = unbounded).
function clipSourceFrames(clip: Clip): number | null {
  if (clip.kind !== 'video' && clip.kind !== 'audio') return null
  const asset = getAsset((clip as any).asset_id)
  if (!asset?.duration_sec) return null
  return Math.max(1, Math.round(asset.duration_sec * store.fps.value))
}

// Floating duration readout while trimming.
const trimHud = ref<null | { x: number; y: number; text: string }>(null)

function showTrimHud(e: PointerEvent, lengthFrames: number, deltaFrames: number) {
  const fps = store.fps.value
  const sign = deltaFrames > 0 ? '+' : ''
  trimHud.value = {
    x: e.clientX + 12, y: e.clientY - 28,
    text: `${(lengthFrames / fps).toFixed(2)}s · ${lengthFrames}f  (${sign}${(deltaFrames / fps).toFixed(2)}s)`,
  }
}

function onClipPointerDown(clipId: string, trackId: string, mode: 'move' | 'resize-right' | 'resize-left', e: PointerEvent) {
  e.stopPropagation()
  e.preventDefault()
  // If the clip isn't already selected, select it (without clearing others
  // if shift/meta is held).
  if (!selectedClipIds.value.has(clipId)) {
    if (e.shiftKey || e.metaKey || e.ctrlKey) toggleSelect(clipId)
    else selectOnly(clipId)
  } else {
    store.selectedClipId.value = clipId  // primary
  }
  const clip = findClip(clipId)
  if (!clip) return
  store.beginGesture()
  drag.value = {
    clipId, trackId, mode,
    startMouseX: e.clientX,
    startStart: clip.start_frame,
    startLength: clip.length,
    startIn: clip.in_frame,
    originTrackId: trackId,
  }
  // Snapshot starts of all selected clips for bulk move.
  if (mode === 'move' && selectedClipIds.value.size > 1) {
    dragGroupStarts = new Map()
    for (const track of store.state.value.tracks) {
      for (const c of track.clips) {
        if (selectedClipIds.value.has(c.id)) dragGroupStarts.set(c.id, c.start_frame)
      }
    }
  } else {
    dragGroupStarts = null
  }
  dragResizeMembers = mode === 'move' ? null : snapshotResizeMembers(clipId)
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onPlayheadPointerDown(e: PointerEvent) {
  e.preventDefault()
  drag.value = { clipId: '', trackId: '', mode: 'playhead', startMouseX: e.clientX, startStart: 0, startLength: 0, startIn: 0, originTrackId: '' }
  const rect = stripRef.value!.getBoundingClientRect()
  const frame = Math.round(pxToFrames(e.clientX - rect.left))
  store.seekFrame(frame)
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
}

// Empty-strip drags draw a marquee; the ruler owns playhead scrubbing.
const marquee = ref<null | { x0: number; y0: number; x1: number; y1: number }>(null)

function onStripPointerDown(e: PointerEvent) {
  // Accept the strip background AND empty lane area (clips stopPropagation).
  const t = e.target as HTMLElement
  const isBg = e.target === e.currentTarget || t.classList.contains('strip-bg') || t.dataset?.lane != null
  if (!isBg) return
  if (e.button !== 0) return
  const rect = stripRef.value!.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  if (y <= RULER_HEIGHT) { onPlayheadPointerDown(e); return }
  marquee.value = { x0: x, y0: y, x1: x, y1: y }
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
}

function applyMarqueeSelection() {
  const m = marquee.value
  if (!m) return
  const fA = pxToFrames(Math.min(m.x0, m.x1))
  const fB = pxToFrames(Math.max(m.x0, m.x1))
  const yA = Math.min(m.y0, m.y1)
  const yB = Math.max(m.y0, m.y1)
  const picked = new Set<string>()
  let top = RULER_HEIGHT
  for (const track of store.state.value.tracks) {
    const h = trackHeight(track)
    const laneHit = top < yB && top + h > yA
    if (laneHit && !track.locked) {
      for (const clip of track.clips) {
        if (clip.start_frame < fB && clip.start_frame + clip.length > fA) picked.add(clip.id)
      }
    }
    top += h
  }
  selectedClipIds.value = picked
  store.selectedClipId.value = picked.size ? [...picked][picked.size - 1]! : null
}

function onPointerMove(e: PointerEvent) {
  if (marquee.value) {
    const rect = stripRef.value!.getBoundingClientRect()
    marquee.value.x1 = e.clientX - rect.left
    marquee.value.y1 = e.clientY - rect.top
    applyMarqueeSelection()
    return
  }
  if (fadeDrag.value) {
    const clip = findClip(fadeDrag.value.clipId)
    if (!clip) return
    const dx = e.clientX - fadeDrag.value.startMouseX
    const df = Math.round(dx / pxPerFrame.value)
    // fade-in grows rightward, fade-out grows leftward
    const raw = fadeDrag.value.side === 'in' ? fadeDrag.value.startFade + df : fadeDrag.value.startFade - df
    const v = Math.max(0, Math.min(raw, clip.length))
    store.updateClip(clip.id, fadeDrag.value.side === 'in' ? { fade_in: v } : { fade_out: v })
    return
  }
  if (kfDrag.value) {
    const clip = findClip(kfDrag.value.clipId)
    if (!clip) return
    const dframes = Math.round((e.clientX - kfDrag.value.startMouseX) / pxPerFrame.value)
    if (dframes !== 0) kfDrag.value.moved = true
    const target = Math.max(0, Math.min(kfDrag.value.startFrame + dframes, Math.max(0, clip.length - 1)))
    if (target !== kfDrag.value.fromFrame) {
      store.moveKeyframe(kfDrag.value.clipId, kfDrag.value.fromFrame, target)
      kfDrag.value.fromFrame = target
      // Keep the playhead glued to the keyframe while retiming.
      store.seekFrame(clip.start_frame + target)
    }
    return
  }
  if (!drag.value) return
  const dx = e.clientX - drag.value.startMouseX
  // Convert delta to frames using zoom only (no scroll offset for deltas).
  const dframes = Math.round(dx / pxPerFrame.value)
  if (drag.value.mode === 'move') {
    const moving = draggingIds()
    const members: Span[] = []
    for (const track of store.state.value.tracks) {
      for (const c of track.clips) {
        if (!moving.has(c.id)) continue
        const s0 = dragGroupStarts?.get(c.id) ?? drag.value.startStart
        members.push({ start: s0, end: s0 + c.length })
      }
    }
    const snapOn = snapEnabled.value !== altHeld.value   // XOR: Alt inverts
    const snapped = snapGroupDelta(members, dframes, snapOn ? buildSnapTargets(moving) : [], SNAP_PX / pxPerFrame.value)
    snapGuideFrame.value = snapped.guideFrame
    const finalStart = drag.value.startStart + snapped.delta
    // Apply: either single clip, or whole selection if bulk-move is active.
    if (dragGroupStarts && dragGroupStarts.size > 1) {
      const clampedDelta = snapped.delta   // already kept above frame 0 by snapGroupDelta
      store.mutate(s => {
        for (const track of s.tracks) {
          for (const c of track.clips) {
            const orig = dragGroupStarts!.get(c.id)
            if (orig != null) c.start_frame = orig + clampedDelta
          }
        }
      })
    } else {
      // Vertical: retarget to another unlocked track of the same kind.
      const idx = trackIndexAtY(e.clientY)
      const clip = findClip(drag.value.clipId)
      let movedTrack = false
      if (idx != null && clip) {
        const target = store.state.value.tracks[idx]!
        const wantKind = clip.kind === 'audio' ? 'audio' : 'video'
        if (target.id !== drag.value.trackId && target.kind === wantKind && !target.locked) {
          store.moveClip(drag.value.clipId, target.id, Math.max(0, finalStart))
          drag.value.trackId = target.id
          moveTargetTrackId.value = target.id
          movedTrack = true
        }
      }
      if (!movedTrack) store.updateClip(drag.value.clipId, { start_frame: Math.max(0, finalStart) })
    }
  } else if (drag.value.mode === 'resize-right' || drag.value.mode === 'resize-left') {
    const edge = drag.value.mode === 'resize-right' ? 'right' : 'left'
    const members = dragResizeMembers ?? []
    // Snap the edge under the mouse, then let the group clamp it ONCE.
    const startEdge = edge === 'right' ? drag.value.startStart + drag.value.startLength : drag.value.startStart
    const snappedEdge = snapFrame(startEdge + dframes, draggingIds())
    const { patches } = computeGroupResize(members, edge, snappedEdge - startEdge)
    store.mutate(s => {
      for (const track of s.tracks) {
        for (const c of track.clips) {
          const p = patches.get(c.id)
          if (p) { c.start_frame = p.start_frame; c.in_frame = p.in_frame; c.length = p.length }
        }
      }
    })
    const mine = patches.get(drag.value.clipId)
    if (mine) showTrimHud(e, mine.length, mine.length - drag.value.startLength)
  } else if (drag.value.mode === 'playhead') {
    const rect = stripRef.value!.getBoundingClientRect()
    const frame = Math.round(pxToFrames(e.clientX - rect.left))
    store.seekFrame(Math.max(0, frame))
  }
}

function onPointerUp() {
  if (marquee.value) {
    const m = marquee.value
    const moved = Math.abs(m.x1 - m.x0) > 3 || Math.abs(m.y1 - m.y0) > 3
    if (!moved) clearSelection()          // plain click on empty area = deselect
    marquee.value = null
    return
  }
  if (fadeDrag.value) {
    fadeDrag.value = null
    store.endGesture()
    return
  }
  if (kfDrag.value) {
    // A click (no drag) parks the playhead on the keyframe.
    if (!kfDrag.value.moved) {
      const clip = findClip(kfDrag.value.clipId)
      if (clip) seekToKeyframe(clip, kfDrag.value.fromFrame)
    }
    kfDrag.value = null
    store.endGesture()
    return
  }
  // Ripple a finished trim: compare with the timeline as the drag began.
  if (rippleEnabled.value && (drag.value?.mode === 'resize-right' || drag.value?.mode === 'resize-left')) {
    const base = store.gestureBaseState()
    if (base) store.mutate(s => { applyRippleEdits(s, computeRippleEdits(base, s)) })
  }
  // A move that ended on top of another clip: hop to a free track (still inside
  // the gesture, so it is part of the same single undo step).
  // Only when the clip really moved: a plain click on a clip that ALREADY
  // overlaps another (older timelines allowed that) must not make it jump.
  if (drag.value?.mode === 'move') {
    const d = drag.value
    const clip = findClip(d.clipId)
    if (clip && (clip.start_frame !== d.startStart || d.trackId !== d.originTrackId)) {
      const moved = draggingIds()
      store.mutate(s => { settleOverlaps(s, moved, () => crypto.randomUUID()) })
    }
  }
  drag.value = null
  snapGuideFrame.value = null
  dragGroupStarts = null
  dragResizeMembers = null
  moveTargetTrackId.value = null
  trimHud.value = null
  store.endGesture()
}

// -- Fade handles (selected clip) --------------------------------------------
//
// Round handles at the clip's top corners; horizontal drag sets fade_in /
// fade_out in frames. Release is handled by the window pointerup (endGesture).

const fadeDrag = ref<null | { clipId: string; side: 'in' | 'out'; startMouseX: number; startFade: number }>(null)

function onFadePointerDown(clipId: string, side: 'in' | 'out', e: PointerEvent) {
  e.stopPropagation(); e.preventDefault()
  const clip = findClip(clipId)
  if (!clip) return
  store.beginGesture()
  fadeDrag.value = { clipId, side, startMouseX: e.clientX, startFade: (side === 'in' ? clip.fade_in : clip.fade_out) ?? 0 }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

// -- Keyframe diamonds (selected clip) -------------------------------------
//
// Diamonds live on the selected clip's bar, positioned at clip-local frames.
// Click a diamond to park the playhead on it; drag to retime it. Dragging
// reuses the global pointer listeners (onPointerMove/onPointerUp).

const kfDrag = ref<null | {
  clipId: string
  fromFrame: number      // current frame of the keyframe being dragged
  startMouseX: number
  startFrame: number     // frame at drag-start
  moved: boolean
}>(null)

function onKeyframePointerDown(clipId: string, frame: number, e: PointerEvent) {
  e.stopPropagation()
  e.preventDefault()
  store.beginGesture()
  kfDrag.value = { clipId, fromFrame: frame, startMouseX: e.clientX, startFrame: frame, moved: false }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function seekToKeyframe(clip: Clip, localFrame: number) {
  store.seekFrame(clip.start_frame + localFrame)
}

// Display the clip's transform AT THE PLAYHEAD: interpolated when keyframed,
// static scalars otherwise. Keeps the inspector honest as the playhead moves
// across keyframes, and ensures edits land on the right keyframe.
const displayTransform = computed(() => {
  const c = selectedClipData.value
  if (!c) return null
  return interpolateClipAt(c, store.clipLocalFrame(c))
})

// Round for display so lerped values don't render as 0.30000000000004.
function r(n: number, d = 2): number {
  const p = 10 ** d
  return Math.round(n * p) / p
}

// -- HTML5 drag-and-drop from asset panel ----------------------------------
//
// MIME: application/x-sailor-asset (we can't rely on text/plain since other
// drops may set it). Payload schema:
//   { kind: 'input-file', path, filename }     — needs import before use
//   { kind: 'library',    asset_id }           — already in library
//   { kind: 'port',       port_index, label }  — wired AI port

interface DragPayload {
  kind: 'input-file' | 'library' | 'port'
  path?: string
  filename?: string
  asset_id?: string
  port_index?: number
  label?: string
}

const dragGhostFrame = ref<number | null>(null)
const dragTargetTrackId = ref<string | null>(null)

function onAssetDragStart(payload: DragPayload, e: DragEvent) {
  if (!e.dataTransfer) return
  e.dataTransfer.effectAllowed = 'copy'
  e.dataTransfer.setData('application/x-sailor-asset', JSON.stringify(payload))
}

function readDragPayload(e: DragEvent): DragPayload | null {
  if (!e.dataTransfer) return null
  const raw = e.dataTransfer.getData('application/x-sailor-asset')
  if (!raw) return null
  try { return JSON.parse(raw) as DragPayload } catch { return null }
}

function onTrackDragOver(trackId: string, e: DragEvent) {
  if (!e.dataTransfer) return
  const types = Array.from(e.dataTransfer.types)
  if (!types.includes('application/x-sailor-asset')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  const rect = stripRef.value!.getBoundingClientRect()
  const rawFrame = Math.max(0, Math.round(pxToFrames(e.clientX - rect.left)))
  // Snap to other clip edges + playhead while dragging in.
  dragGhostFrame.value = snapFrame(rawFrame, new Set<string>())
  dragTargetTrackId.value = trackId
}

function onTrackDragLeave() {
  // Don't clear immediately — sibling moves trigger leave→enter quickly.
  // We clear on drop or drop end.
}

async function onTrackDrop(trackId: string, e: DragEvent) {
  e.preventDefault()
  const payload = readDragPayload(e)
  if (!payload) return
  const rect = stripRef.value!.getBoundingClientRect()
  const rawFrame = Math.max(0, Math.round(pxToFrames(e.clientX - rect.left)))
  const startFrame = dragGhostFrame.value ?? rawFrame
  dragGhostFrame.value = null
  dragTargetTrackId.value = null
  snapGuideFrame.value = null

  // Resolve to an asset record (importing if needed).
  let resolvedAsset: any = null
  if (payload.kind === 'input-file' && payload.path) {
    resolvedAsset = await importAsset(payload.path)
  } else if (payload.kind === 'library' && payload.asset_id) {
    resolvedAsset = getAsset(payload.asset_id)
  } else if (payload.kind === 'port' && payload.port_index != null) {
    // WorkflowClip — no asset, just port index.
    const fps = store.fps.value
    store.addClip(trackId, {
      id: crypto.randomUUID(),
      kind: 'workflow',
      port_index: payload.port_index,
      start_frame: startFrame,
      in_frame: 0,
      length: fps * 5,
      x: 0, y: 0, rotation: 0, scale: 1,
      opacity: 1, blend: 'normal',
      fade_in: 0, fade_out: 0,
    } as Clip)
    return
  }

  if (!resolvedAsset) return
  const fps = store.fps.value
  const lengthFrames = resolvedAsset.duration_sec ? Math.round(resolvedAsset.duration_sec * fps) : fps * 5
  const track = store.state.value.tracks.find(t => t.id === trackId)
  // Auto-route: if user drops an audio file onto a video track, redirect to
  // the first audio track (creating one if needed).
  let finalTrackId = trackId
  if (track?.kind === 'video' && resolvedAsset.kind === 'audio') {
    let audioTrack = store.state.value.tracks.find(t => t.kind === 'audio' && !t.locked)
    if (!audioTrack) {
      store.addTrack('audio')
      audioTrack = store.state.value.tracks[store.state.value.tracks.length - 1]
    }
    finalTrackId = audioTrack!.id
  } else if (track?.kind === 'audio' && (resolvedAsset.kind === 'video' || resolvedAsset.kind === 'image')) {
    let videoTrack = store.state.value.tracks.find(t => t.kind === 'video' && !t.locked)
    if (!videoTrack) {
      store.addTrack('video')
      videoTrack = store.state.value.tracks[store.state.value.tracks.length - 1]
    }
    finalTrackId = videoTrack!.id
  }

  store.addClip(finalTrackId, {
    id: crypto.randomUUID(),
    kind: resolvedAsset.kind as any,
    asset_id: resolvedAsset.id,
    start_frame: startFrame,
    in_frame: 0,
    length: lengthFrames,
    x: 0, y: 0, rotation: 0, scale: 1,
    opacity: 1, blend: 'normal',
    fade_in: 0, fade_out: 0,
    volume: 1,
  } as Clip)
}

function findClip(id: string): Clip | undefined {
  for (const track of store.state.value.tracks) {
    const clip = track.clips.find(c => c.id === id)
    if (clip) return clip
  }
  return undefined
}

// -- Render --

const isRendering = ref(false)
const renderResult = ref<null | { url: string; filename: string }>(null)
const renderError = ref<string | null>(null)
/** Something the export could not do, shown beside the result (not a failure). */
const renderNotice = ref<string | null>(null)
const renderProgress = ref<{ current: number; total: number } | null>(null)
/** Which half of an export is running. Space Type clips bake in the browser
 *  before the server renders, and that bake is slow enough to look like a hang
 *  — so the button must say which phase the bar is measuring, or it fills to
 *  100% twice with no explanation. */
const renderPhase = ref<'baking' | 'rendering' | null>(null)

async function renderViaFFmpeg() {
  if (isRendering.value) return
  renderError.value = null
  renderNotice.value = null
  renderResult.value = null
  renderProgress.value = null
  isRendering.value = true

  const es = store.state.value
  const assetLib = assetsList.value
  const fps = es.canvas.fps
  const W = es.canvas.width
  const H = es.canvas.height

  // Bake any Motion clips against the REAL store clips first so motion_bake
  // caches across exports (a re-export with no kinetic edits skips re-baking).
  ensureMotionFonts(es)
  for (const track of es.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === 'motion') {
        // Externally baked (e.g. Space Type) — frames are authoritative; re-baking
        // from the placeholder text layer would blank them.
        if ((clip as MotionClip).motion_bake?.external) continue
        try {
          await ensureMotionBake(clip as MotionClip, W, H, fps)
        } catch (err: any) {
          isRendering.value = false
          renderError.value = `kinetic bake failed: ${err?.message ?? err}`
          return
        }
      }
    }
  }

  // Space Type clips render live in the browser but Python can't run three.js,
  // so bake one seamless cycle per clip. Unlike Motion (Canvas2D text, ~instant)
  // a supersampled three.js bake is slow enough that a silent stall reads as a
  // hang — hence the per-frame progress into the same status the render uses.
  const spaceTypeClips = es.tracks.flatMap(t => t.clips).filter(c => c.kind === 'spacetype') as SpaceTypeClip[]
  if (spaceTypeClips.length && !spaceTypeEngineAvailable()) {
    isRendering.value = false
    renderError.value = 'This timeline has Space Type clips, which need WebGL2 to render. Export is unavailable in this browser.'
    return
  }
  if (spaceTypeClips.length) renderPhase.value = 'baking'
  for (let i = 0; i < spaceTypeClips.length; i++) {
    const clip = spaceTypeClips[i]!
    try {
      clip.spacetype_bake = await ensureSpaceTypeClipBake(clip, (done, total) => {
        // Progress across ALL Space Type clips, so the bar advances once rather
        // than resetting per clip.
        renderProgress.value = { current: i * total + done, total: spaceTypeClips.length * total }
      })
    } catch (err: any) {
      isRendering.value = false
      renderPhase.value = null
      renderProgress.value = null
      renderError.value = `Space Type bake failed: ${err?.message ?? err}`
      return
    }
  }
  // Mix every audio clip (all tracks, position, volume, fades, speed, reverse)
  // into one file in the browser — the same voices the preview plays — and hand
  // the server that. If it fails the export still runs, with the old
  // first-clip-only sound, and says so.
  let mixFile: string | null = null
  try {
    mixFile = await ensureTimelineMix(es, clip => resolveAudioUrl(clip), store.boundNodeId())
  } catch (err: any) {
    console.warn('[timeline] audio mix failed', err)
    renderNotice.value = `Audio could not be mixed (${err?.message ?? err}), so this export only has the first audio clip.`
  }

  renderPhase.value = 'rendering'
  renderProgress.value = null

  const payload: any = JSON.parse(JSON.stringify(es))
  for (const track of payload.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'audio') {
        const asset = assetLib.find((a: any) => a.id === clip.asset_id)
        if (asset) clip.path = asset.path
      } else if (clip.kind === 'motion') {
        clip.motion_frames = clip.motion_bake?.frames ?? []
      } else if (clip.kind === 'spacetype') {
        // One seamless cycle; the exporter tiles it across the clip length.
        clip.spacetype_frames = clip.spacetype_bake?.frames ?? []
        clip.spacetype_loop = clip.loop !== false
      } else if (clip.kind === 'workflow') {
        // A clip fed by a wired node. If that node resolves to a real input/
        // file (LoadVideo / Video / LoadImage / Image), render it as a normal
        // clip. Only genuinely-computed ports (no resolvable file) fall through
        // to the backend's workflow-skip — those need an in-graph run for pixels.
        const resolved = resolveClipPreview(clip)
        const filename = resolved && (resolved.kind === 'video' || resolved.kind === 'image')
          ? inputFilenameFromUrl(resolved.url)
          : null
        if (resolved && filename) {
          clip.kind = resolved.kind
          clip.path = filename
        }
      }
    }
  }
  if (mixFile) payload.audio_path = mixFile

  try {
    const res = await fetch('/sailor/render_timeline_stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

    // NDJSON stream: read line-by-line.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'progress') {
            renderProgress.value = { current: msg.current, total: msg.total }
          } else if (msg.type === 'result') {
            const filename = String(msg.result?.filename ?? '')
            if (filename) renderResult.value = { url: `/view?${new URLSearchParams({ filename, type: 'output' })}`, filename }
          } else if (msg.type === 'error') {
            renderError.value = msg.error || 'render failed'
          }
        } catch {}
      }
    }
  } catch (err: any) {
    renderError.value = err?.message ?? 'render failed'
  } finally {
    isRendering.value = false
    renderProgress.value = null
    renderPhase.value = null
  }
}

// -- Keyboard --
//
// The editor owns the keyboard while open. We register in the capture phase
// and stopImmediatePropagation on every key — otherwise Backspace/Delete bubble
// up to VueFlow's global listener and delete the selected Timeline node on the
// underlying canvas. Inputs/selects still get their native behavior (we bail
// before touching the event).

function handleKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return

  // Anything else: this is our keyboard.
  e.stopImmediatePropagation()

  if (e.key === 'Escape') { emit('close'); return }
  if (e.key === ' ') { e.preventDefault(); store.togglePlay(); return }
  if (e.key === 'ArrowLeft') { e.preventDefault(); store.stepFrames(-1); return }
  if (e.key === 'ArrowRight') { e.preventDefault(); store.stepFrames(1); return }
  if (e.key === 's' && !e.metaKey && !e.ctrlKey) {
    if (store.selectedClipId.value) {
      e.preventDefault()
      store.splitAtPlayhead(store.selectedClipId.value)
    }
    return
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    if (selectedClipIds.value.size <= 1 && store.selectedClipId.value && (e.metaKey || e.ctrlKey)) {
      store.rippleDelete(store.selectedClipId.value)
      clearSelection()
    } else {
      deleteSelection()
    }
    return
  }
  if (e.key === 'Home') { e.preventDefault(); store.seek(0); return }
  if (e.key === 'End') { e.preventDefault(); store.seek(store.totalSec.value); return }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); return }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) { e.preventDefault(); store.redo(); return }
  if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
    e.preventDefault()
    const all = new Set<string>()
    for (const track of store.state.value.tracks) {
      if (track.locked) continue
      for (const clip of track.clips) all.add(clip.id)
    }
    selectedClipIds.value = all
    store.selectedClipId.value = all.size ? [...all][all.size - 1]! : null
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
    e.preventDefault()
    if (selectedClipIds.value.size) store.copyClips(selectedClipIds.value)
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
    e.preventDefault()
    pasteAndSelect(store.playheadFrame.value)
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
    e.preventDefault()
    if (selectedClipIds.value.size) {
      const ids = store.duplicateClips(selectedClipIds.value)
      selectedClipIds.value = new Set(ids)
      store.selectedClipId.value = ids[ids.length - 1] ?? null
    }
    return
  }
}

// -- Transitions (junction chips) ----------------------------------------------
//
// A chip sits on every exact junction (from.end == to.start) of a video track.
// Click → popover with kind + duration; writes go through the command layer
// (add/update/remove_transition). Rendering happens in the engines/export via
// shared/timeline/transitions.ts and its Python twin.

interface Junction {
  trackId: string
  fromId: string
  toId: string
  frame: number
  transition: Transition | null
}

const TRANSITION_KINDS: { kind: TransitionKind; label: string }[] = [
  { kind: 'crossfade', label: 'Crossfade' },
  { kind: 'wipe_left', label: 'Wipe ←' },
  { kind: 'wipe_right', label: 'Wipe →' },
  { kind: 'slide_up', label: 'Slide ↑' },
  { kind: 'slide_down', label: 'Slide ↓' },
]

function junctionsFor(track: Track): Junction[] {
  if (track.kind !== 'video') return []
  const sorted = [...track.clips].sort((a, b) => a.start_frame - b.start_frame)
  const out: Junction[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    if (a.start_frame + a.length !== b.start_frame) continue
    out.push({
      trackId: track.id,
      fromId: a.id,
      toId: b.id,
      frame: b.start_frame,
      transition: (store.state.value.transitions ?? []).find(
        t => t.from_clip_id === a.id && t.to_clip_id === b.id) ?? null,
    })
  }
  return out
}

const trPopover = ref<null | { x: number; y: number; junction: Junction }>(null)

function windowWidth(): number {
  return typeof window === 'undefined' ? 1600 : window.innerWidth
}

function openTransitionPopover(j: Junction, e: MouseEvent) {
  trPopover.value = { x: e.clientX, y: e.clientY, junction: j }
}

function setJunctionKind(kind: TransitionKind | null) {
  const p = trPopover.value
  if (!p) return
  const existing = p.junction.transition
  if (kind === null) {
    if (existing) store.removeTransition(existing.id)
    trPopover.value = null
    return
  }
  if (existing) {
    store.updateTransition(existing.id, { kind })
  } else {
    store.addTransition({
      id: crypto.randomUUID(),
      track_id: p.junction.trackId,
      from_clip_id: p.junction.fromId,
      to_clip_id: p.junction.toId,
      kind,
      duration: Math.max(2, Math.round(0.5 * store.fps.value)),
    })
  }
  // Re-resolve so the popover reflects the new state.
  const track = store.state.value.tracks.find(t => t.id === p.junction.trackId)
  if (track) {
    const fresh = junctionsFor(track).find(j => j.fromId === p.junction.fromId && j.toId === p.junction.toId)
    if (fresh) trPopover.value = { ...p, junction: fresh }
  }
}

function setJunctionDuration(rawSec: string) {
  const p = trPopover.value
  if (!p?.junction.transition) return
  const frames = Math.max(2, Math.round((parseFloat(rawSec) || 0.5) * store.fps.value))
  store.updateTransition(p.junction.transition.id, { duration: frames })
  setJunctionKind(p.junction.transition.kind) // refresh popover junction snapshot
}

// -- Filters / color adjust (visual clips) ------------------------------------
//
// Writes prune identity values so untouched clips stay clean in the schema.
// Semantics live in shared/timeline/filters.ts (+ Python twin).

const FILTER_DEFS = [
  { key: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.01, def: 0 },
  { key: 'contrast', label: 'Contrast', min: 0, max: 3, step: 0.01, def: 1 },
  { key: 'saturation', label: 'Saturation', min: 0, max: 3, step: 0.01, def: 1 },
  { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, def: 0 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01, def: 0 },
] as const

type FilterKey = typeof FILTER_DEFS[number]['key']

function filterValue(clip: Clip, key: FilterKey): number {
  const def = FILTER_DEFS.find(d => d.key === key)!
  return (clip.filters as any)?.[key] ?? def.def
}

function setFilterValue(clip: Clip, key: FilterKey, raw: number) {
  const next: Record<string, number> = { ...(clip.filters ?? {}) }
  const def = FILTER_DEFS.find(d => d.key === key)!
  const v = Math.max(def.min, Math.min(def.max, raw))
  if (v === def.def) delete next[key]
  else next[key] = v
  store.updateClip(clip.id, { filters: Object.keys(next).length ? next : undefined })
}

function resetFilters(clip: Clip) {
  if (clip.filters) store.updateClip(clip.id, { filters: undefined })
}

const FILTERABLE_KINDS = new Set(['video', 'image', 'workflow'])

// -- Speed (video/audio clips) -----------------------------------------------
//
// CapCut semantics: changing speed rescales the clip's timeline length so the
// covered SOURCE range stays the same (2× ⇒ half as long). One update_clip
// dispatch patches both fields ⇒ one undo step. Keyframes are clip-local
// OUTPUT frames — they intentionally don't move (tooltip says so).

const SPEED_PRESETS = [0.5, 1, 1.5, 2]

function setClipSpeed(clip: Clip, rawSpeed: number) {
  const next = Math.max(0.1, Math.min(5, rawSpeed || 1))
  const prev = clip.speed ?? 1
  if (next === prev) return
  store.updateClip(clip.id, {
    speed: next,
    length: Math.max(1, Math.round(clip.length * (prev / next))),
  })
}

// Delete everything selected as ONE undo step. With ripple on, later clips
// close the gaps.
function deleteSelection() {
  const ids = selectedClipIds.value.size > 1
    ? new Set(selectedClipIds.value)
    : new Set(store.selectedClipId.value ? [store.selectedClipId.value] : [])
  if (!ids.size) return
  store.mutate(s => {
    const before: EditState = JSON.parse(JSON.stringify(s))
    for (const track of s.tracks) track.clips = track.clips.filter(c => !ids.has(c.id))
    s.transitions = s.transitions.filter(t => !ids.has(t.from_clip_id) && !ids.has(t.to_clip_id))
    if (rippleEnabled.value) applyRippleEdits(s, computeRippleEdits(before, s))
  })
  if (store.selectedClipId.value && ids.has(store.selectedClipId.value)) store.selectedClipId.value = null
  clearSelection()
}

function pasteAndSelect(frame: number) {
  const ids = store.pasteClips(frame)
  if (ids.length) {
    selectedClipIds.value = new Set(ids)
    store.selectedClipId.value = ids[ids.length - 1]!
  }
}

// -- Context menus (clip / lane / track header) ------------------------------

const ctxMenu = ref<null | { x: number; y: number; items: (MenuItem | 'sep')[] }>(null)

function clipMenuItems(clipId: string): (MenuItem | 'sep')[] {
  const clip = findClip(clipId)
  const insidePlayhead = !!clip
    && store.playheadFrame.value > clip.start_frame
    && store.playheadFrame.value < clip.start_frame + clip.length
  const ids = selectedClipIds.value.has(clipId) ? [...selectedClipIds.value] : [clipId]
  return [
    { label: 'Split at playhead', shortcut: 'S', disabled: !insidePlayhead, action: () => store.splitAtPlayhead(clipId) },
    { label: 'Duplicate', shortcut: '⌘D', action: () => { const n = store.duplicateClips(ids); selectedClipIds.value = new Set(n); store.selectedClipId.value = n[n.length - 1] ?? null } },
    'sep',
    { label: 'Copy', shortcut: '⌘C', action: () => store.copyClips(ids) },
    { label: 'Paste', shortcut: '⌘V', disabled: !store.hasClipboard.value, action: () => pasteAndSelect(store.playheadFrame.value) },
    'sep',
    { label: 'Delete', shortcut: '⌫', danger: true, action: () => { const del = new Set(ids); store.mutate(s => { for (const t of s.tracks) t.clips = t.clips.filter(c => !del.has(c.id)) }); clearSelection() } },
    { label: 'Ripple delete', shortcut: '⌘⌫', danger: true, action: () => { store.rippleDelete(clipId); clearSelection() } },
  ]
}

function laneMenuItems(trackId: string, frame: number): (MenuItem | 'sep')[] {
  return [
    { label: 'Paste here', shortcut: '⌘V', disabled: !store.hasClipboard.value, action: () => pasteAndSelect(frame) },
    'sep',
    { label: 'Add video track', action: () => store.addTrack('video') },
    { label: 'Add audio track', action: () => store.addTrack('audio') },
    'sep',
    deleteTrackItem(trackId),
  ]
}

function headerMenuItems(trackId: string): (MenuItem | 'sep')[] {
  return [
    { label: 'Rename', action: () => { renamingTrackId.value = trackId } },
    'sep',
    deleteTrackItem(trackId),
  ]
}

function deleteTrackItem(trackId: string): MenuItem {
  const track = store.state.value.tracks.find(t => t.id === trackId)
  const lastOfKind = !!track && store.state.value.tracks.filter(t => t.kind === track.kind).length <= 1
  return {
    label: 'Delete track', danger: true, disabled: lastOfKind,
    action: () => {
      if (!track) return
      if (track.clips.length && !window.confirm(`Delete "${track.name}" and its ${track.clips.length} clip${track.clips.length === 1 ? '' : 's'}?`)) return
      store.removeTrack(trackId)
    },
  }
}

function onClipContextMenu(clipId: string, e: MouseEvent) {
  e.preventDefault(); e.stopPropagation()
  if (!selectedClipIds.value.has(clipId)) selectOnly(clipId)
  ctxMenu.value = { x: e.clientX, y: e.clientY, items: clipMenuItems(clipId) }
}

function onLaneContextMenu(trackId: string, e: MouseEvent) {
  e.preventDefault()
  const rect = stripRef.value!.getBoundingClientRect()
  const frame = Math.max(0, Math.round(pxToFrames(e.clientX - rect.left)))
  ctxMenu.value = { x: e.clientX, y: e.clientY, items: laneMenuItems(trackId, frame) }
}

function onHeaderContextMenu(trackId: string, e: MouseEvent) {
  e.preventDefault()
  ctxMenu.value = { x: e.clientX, y: e.clientY, items: headerMenuItems(trackId) }
}

// -- Track rename --

const renamingTrackId = ref<string | null>(null)
function commitTrackName(trackId: string, name: string) {
  const trimmed = name.trim()
  if (trimmed) store.mutate(s => { const t = s.tracks.find(t2 => t2.id === trackId); if (t) t.name = trimmed })
  renamingTrackId.value = null
}

// -- Helpers --

const selectedClipData = computed(() => store.selectedClip.value)

// Narrowed to a Motion clip for the Motion inspector (null otherwise).
const selectedMotionClip = computed<MotionClip | null>(() =>
  selectedClipData.value?.kind === 'motion' ? selectedClipData.value : null)

// Narrowed to a Space Type clip for the sync-from-node inspector (null otherwise).
const selectedSpaceTypeClip = computed<SpaceTypeClip | null>(() =>
  selectedClipData.value?.kind === 'spacetype' ? selectedClipData.value : null)

// Current state of the clip's origin node, resolved by id against the live node
// canvas. `origin` is advisory (Task 6 design): a missing id or a deleted node
// both degrade to null — never an error — so the inspector simply omits the
// sync affordance instead of surfacing a warning.
const spaceTypeOriginNodeState = computed<SpaceTypeState | null>(() => {
  const nodeId = selectedSpaceTypeClip.value?.origin?.node_id
  if (!nodeId) return null
  const node = props.nodes.find((n: any) => n.id === nodeId)
  const cfg = node?.data?.properties?.sailor_spaceType
  return cfg && typeof cfg === 'object' ? (cfg as SpaceTypeState) : null
})

function clipIcon(kind: string) {
  if (kind === 'video') return Film
  if (kind === 'audio') return Music
  if (kind === 'image') return ImageIcon
  if (kind === 'text') return Type
  if (kind === 'workflow') return Cpu
  return Film
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = (sec % 60).toFixed(1)
  return `${m}:${s.padStart(4, '0')}`
}

// Seconds at the DISPLAY EDGE only — the model stays in frames.
function fToS(frames: number): string {
  return (frames / store.fps.value).toFixed(2)
}
function sToF(raw: string): number {
  return Math.max(0, Math.round((parseFloat(raw) || 0) * store.fps.value))
}

// -- AI ports (graph wiring) ---------------------------------------------------
// Walk the edges to find what's connected to this Timeline node's clip ports.
// Each becomes a "WorkflowClip" candidate the user can drop on the timeline —
// its pixels come from upstream graph execution, not a file on disk.

// Must match _MAX_CLIPS in comfy_extras/nodes_timeline.py.
const MAX_CLIP_PORTS = 16

interface PortBinding {
  port_index: number              // 1..MAX_CLIP_PORTS
  upstream_id: string             // upstream node id
  upstream_type: string           // LoadVideo, LoadImage, etc.
  preview_label: string           // human-readable hint (e.g. filename)
  duration_frames: number | null  // best guess for the WorkflowClip length
}

const portBindings = computed<PortBinding[]>(() => {
  const out: PortBinding[] = []
  for (let i = 1; i <= MAX_CLIP_PORTS; i++) {
    // The Timeline node's image inputs are positioned at indexes 0..N-1 — the
    // canvas labels them clipN but VueFlow handles them as 'input-(N-1)'.
    const edge = props.edges.find((e: any) =>
      e.target === props.nodeId && e.targetHandle === `input-${i - 1}`)
    if (!edge) continue
    const src = props.nodes.find((n: any) => n.id === edge.source)
    if (!src) continue
    const type = String(src.data?.nodeType ?? '')

    // Best-effort label: pull a filename from common load nodes.
    let label = type
    let duration: number | null = null
    if (type === 'LoadVideo' || type === 'LoadVideoFrames') {
      const idx = (src.data?.widgetDefs as any[] | undefined)?.findIndex((d: any) => d.name === 'file') ?? 0
      const fname = src.data?.widgetsValues?.[idx >= 0 ? idx : 0]
      if (fname) label = String(fname)
    } else if (type === 'LoadImage') {
      const idx = (src.data?.widgetDefs as any[] | undefined)?.findIndex((d: any) => d.name === 'image') ?? 0
      const fname = src.data?.widgetsValues?.[idx >= 0 ? idx : 0]
      if (fname) label = String(fname)
      duration = 1  // single image — let the user lengthen it manually
    } else if (type === 'Video' || type === 'Image') {
      // Universal artifact nodes: surface the uploaded filename if present.
      const widgetName = type === 'Video' ? 'file' : 'image'
      const idx = (src.data?.widgetDefs as any[] | undefined)?.findIndex((d: any) => d.name === widgetName) ?? -1
      const fname = idx >= 0 ? src.data?.widgetsValues?.[idx] : undefined
      if (fname) label = String(fname)
      if (type === 'Image') duration = 1
    } else if (type === 'VectorType') {
      // Label from the studio config; length from whichever the node can offer.
      // A node migrated from the retired KineticType still carries that node's
      // baked frames, and their count IS the clip length the user had — so it
      // wins over the declared clip, which a re-bake has not yet honoured.
      // Without this branch every migrated clip would silently fall back to the
      // 5-second default below.
      const blob = (src.data?.properties?.sailor_vectorType ?? {}) as any
      const text = blob?.config?.text
      if (typeof text === 'string' && text) label = `"${text}"`
      const frames = (src.data?.properties?.sailor_kineticLegacy as any)?.frames
      if (Array.isArray(frames) && frames.length > 0) {
        duration = frames.length
      } else {
        const secs = Number(blob?.config?.motion?.duration)
        const nodeFps = Number(blob?.config?.motion?.fps)
        if (Number.isFinite(secs) && secs > 0 && Number.isFinite(nodeFps) && nodeFps > 0) {
          duration = Math.max(1, Math.round(secs * nodeFps))
        }
      }
    }

    out.push({
      port_index: i,
      upstream_id: src.id,
      upstream_type: type,
      preview_label: label,
      duration_frames: duration,
    })
  }
  return out
})

function addPortToTimeline(binding: PortBinding) {
  const fps = store.fps.value
  // For workflow clips we can't probe duration up front; default to 5s, the
  // user can drag the right edge.
  const lengthFrames = binding.duration_frames ?? fps * 5
  let videoTrack = store.state.value.tracks.find(t => t.kind === 'video' && !t.locked)
  if (!videoTrack) {
    store.addTrack('video')
    videoTrack = store.state.value.tracks[store.state.value.tracks.length - 1]
  }
  const maxEnd = videoTrack!.clips.reduce((m, c) => Math.max(m, c.start_frame + c.length), 0)
  store.addClip(videoTrack!.id, {
    id: crypto.randomUUID(),
    kind: 'workflow',
    port_index: binding.port_index,
    start_frame: maxEnd,
    in_frame: 0,
    length: lengthFrames,
    x: 0, y: 0, rotation: 0, scale: 1,
    opacity: 1, blend: 'normal',
    fade_in: 0, fade_out: 0,
  } as Clip)
}

// -- Asset usage (how many clips reference each asset) --
function assetUsageCount(assetId: string): number {
  let n = 0
  for (const track of store.state.value.tracks) {
    for (const clip of track.clips) {
      if ((clip as any).asset_id === assetId) n++
    }
  }
  return n
}

// -- Clip preview (thumbnails / waveforms) --
//
// Filmstrip thumbnail count is derived from the clip's current screen width
// so a 1-second clip gets ~1 thumb and a 30-second clip gets ~6.

function clipFilmstripCount(clip: Clip): number {
  if (clip.kind === 'image' || clip.kind === 'text') return 1
  const widthPx = Math.max(8, clip.length * pxPerFrame.value)
  return Math.max(1, Math.min(12, Math.floor(widthPx / 80)))
}

function clipThumbAssetId(clip: Clip): string | null {
  if (clip.kind === 'video' || clip.kind === 'image') return (clip as any).asset_id ?? null
  if (clip.kind === 'workflow') {
    // Use the upstream LoadVideo's file path → asset_id is unstable so we
    // skip thumbnails for workflow clips for now (Phase 1).
    return null
  }
  return null
}

function clipThumbs(clip: Clip): string[] {
  void thumbVersion.value  // reactivity
  const id = clipThumbAssetId(clip)
  if (!id) return []
  return getThumbs(id, clipFilmstripCount(clip)) ?? []
}

// One-frame thumb for an IMPORTED asset (client-cached via useClipPreview).
function assetThumb(assetId: string): string | null {
  void thumbVersion.value  // reactivity
  return getThumbs(assetId, 1)?.[0] ?? null
}

// Raw input-file rows fetch straight from the PNG endpoint — loading="lazy"
// on the <img> means only on-screen rows hit the server (the show-all list
// can be thousands of files).
function inputThumbUrl(filename: string): string {
  return `/sailor/input_thumbnail?filename=${encodeURIComponent(filename)}`
}

// Media kind from a raw input filename (imported assets carry .kind already).
function inputFileKind(filename: string): 'video' | 'audio' | 'image' {
  if (/\.(mp4|mov|webm|mxf|m4v)$/i.test(filename)) return 'video'
  if (/\.(mp3|wav|flac|m4a|ogg|aac)$/i.test(filename)) return 'audio'
  return 'image'
}

function hideBrokenThumb(e: Event) {
  ;(e.target as HTMLImageElement).style.display = 'none'
}

const WAVEFORM_BUCKETS = 256
function clipWaveform(clip: Clip): number[] | null {
  void waveVersion.value
  if (clip.kind !== 'audio') return null
  const id = (clip as any).asset_id
  if (!id) return null
  return getWaveform(id, WAVEFORM_BUCKETS)
}

function waveformPath(peaks: number[], widthPx: number, heightPx: number): string {
  if (!peaks.length || widthPx <= 0) return ''
  // Build a symmetric polyline: top half from peaks, bottom mirror.
  const mid = heightPx / 2
  const n = peaks.length
  const top: string[] = []
  const bot: string[] = []
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * widthPx
    const amp = peaks[i]! * (heightPx / 2)
    top.push(`${x.toFixed(1)},${(mid - amp).toFixed(1)}`)
    bot.push(`${x.toFixed(1)},${(mid + amp).toFixed(1)}`)
  }
  return `M ${top.join(' L ')} L ${bot.reverse().join(' L ')} Z`
}

// -- Asset panel tab --
// Default to AI ports if any are wired; otherwise files. Avoids the dump-of-input/
// surprise when the user comes from a wired graph.
const assetTab = ref<'ports' | 'files' | 'library'>(portBindings.value.length > 0 ? 'ports' : 'files')
</script>

<template>
  <div
    class="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
    @click.self="emit('close')"
  >
    <!-- Extra-wide modal (not full-bleed): caps at 1780px so ultrawide monitors
         keep some canvas visible behind the backdrop; near-full on laptops. -->
    <div class="w-[min(1780px,100%)] h-[min(1040px,100%)] bg-[#0a0a0a] flex flex-col text-white/85 overflow-hidden rounded-xl border border-white/10 shadow-2xl">

      <!-- Top bar -->
      <div class="flex items-center gap-3 px-4 h-10 border-b border-white/10 shrink-0">
        <span class="text-sm font-semibold tracking-tight">Timeline Editor</span>
        <div class="w-px h-5 bg-white/10" />
        <span class="text-[10px] text-white/40 tabular-nums">
          {{ store.state.value.canvas.width }}×{{ store.state.value.canvas.height }}
          · {{ store.fps.value }}fps
        </span>
        <div class="flex items-center gap-1 ml-2">
          <button
            class="flex items-center justify-center size-6 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
            :disabled="!store.canUndo.value"
            title="Undo (⌘Z)"
            @click="store.undo()"
          ><Undo2 class="size-3.5" /></button>
          <button
            class="flex items-center justify-center size-6 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
            :disabled="!store.canRedo.value"
            title="Redo (⌘⇧Z)"
            @click="store.redo()"
          ><Redo2 class="size-3.5" /></button>
        </div>

        <div class="flex items-center gap-1 ml-2">
          <button
            class="flex items-center gap-1.5 px-2 h-6 rounded text-xs text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            title="Add Kinetic Text clip at playhead"
            @click="addKineticText()"
          ><Type class="size-3.5" /> Kinetic Text</button>
        </div>

        <div class="ml-auto flex items-center gap-2">
          <!-- Export button + inline progress fill -->
          <button
            class="relative overflow-hidden flex items-center gap-1.5 px-3 h-7 rounded text-xs transition-colors border border-white/10 disabled:opacity-90 min-w-[110px]"
            :class="renderResult ? 'bg-action/20 hover:bg-action/30 text-action' : 'bg-white/15 hover:bg-white/20 text-white/70'"
            :disabled="isRendering"
            @click="renderViaFFmpeg"
          >
            <!-- Progress fill -->
            <div
              v-if="renderProgress && renderProgress.total > 0"
              class="absolute inset-y-0 left-0 bg-white/25 transition-[width]"
              :style="{ width: (renderProgress.current / renderProgress.total * 100).toFixed(1) + '%' }"
            />
            <RotateCw class="size-3 relative" :class="isRendering ? 'animate-spin' : ''" />
            <span class="relative">
              {{
                isRendering
                  ? (renderPhase === 'baking'
                      ? (renderProgress ? `Baking ${Math.round(renderProgress.current / Math.max(1, renderProgress.total) * 100)}%` : 'Baking…')
                      : (renderProgress ? `${Math.round(renderProgress.current / Math.max(1, renderProgress.total) * 100)}%` : 'Rendering…'))
                  : (renderResult ? 'Re-render' : 'Export')
              }}
            </span>
          </button>
          <a v-if="renderResult" :href="renderResult.url" target="_blank"
            class="text-xs text-action hover:text-action/80 underline underline-offset-2">
            {{ renderResult.filename }}
          </a>
          <span v-if="renderError" class="text-xs text-amber-400 truncate max-w-[200px]">{{ renderError }}</span>
          <span v-if="renderNotice" class="text-xs text-white/50 truncate max-w-[280px]" :title="renderNotice">{{ renderNotice }}</span>
          <button
            class="flex items-center justify-center size-7 rounded hover:bg-white/10 transition-colors"
            title="Close (Esc)"
            @click="emit('close')"
          ><X class="size-4" /></button>
        </div>
      </div>

      <!-- Main 3-pane area -->
      <div class="flex-1 flex min-h-0">

        <!-- Left: asset library -->
        <div class="w-56 border-r border-white/10 flex flex-col shrink-0">
          <div class="flex border-b border-white/10">
            <button
              class="flex-1 px-2 py-2 text-[11px] transition-colors"
              :class="assetTab === 'ports' ? 'text-white bg-white/5' : 'text-white/50 hover:text-white/70'"
              @click="assetTab = 'ports'"
            >
              AI Ports
              <span v-if="portBindings.length" class="ml-1 text-white/70 tabular-nums">{{ portBindings.length }}</span>
            </button>
            <button
              class="flex-1 px-2 py-2 text-[11px] transition-colors"
              :class="assetTab === 'files' ? 'text-white bg-white/5' : 'text-white/50 hover:text-white/70'"
              title="Media used or generated by this project's canvases"
              @click="assetTab = 'files'"
            >Project</button>
            <button
              class="flex-1 px-2 py-2 text-[11px] transition-colors"
              :class="assetTab === 'library' ? 'text-white bg-white/5' : 'text-white/50 hover:text-white/70'"
              title="Files already imported into this timeline — a green dot marks ones on a track"
              @click="assetTab = 'library'"
            >Imported</button>
          </div>
          <div class="flex-1 overflow-y-auto p-2">
            <template v-if="assetTab === 'ports'">
              <div
                v-for="binding in portBindings"
                :key="binding.port_index"
                class="group flex items-center gap-2 px-2 py-1.5 rounded text-xs cursor-grab active:cursor-grabbing hover:bg-white/10 transition-colors"
                draggable="true"
                :title="`Drag onto a track — or click to append`"
                @dragstart="(e) => onAssetDragStart({ kind: 'port', port_index: binding.port_index, label: binding.preview_label }, e)"
                @click="addPortToTimeline(binding)"
              >
                <Cpu class="size-3 text-white/70 shrink-0" />
                <div class="flex-1 min-w-0">
                  <div class="text-white/80 truncate">Clip{{ binding.port_index }}</div>
                  <div class="text-white/35 text-[10px] truncate">{{ binding.preview_label }}</div>
                </div>
                <Plus class="size-3 text-white/30 group-hover:text-white/70 transition-colors" />
              </div>
              <div v-if="!portBindings.length" class="text-xs text-white/30 px-2 py-4 italic">
                Nothing wired to a clip port yet. Drag a LoadVideo or any upstream node into the Timeline node's clip port on the canvas — the port auto-grows.
              </div>
            </template>
            <template v-else-if="assetTab === 'files'">
              <div class="px-2 pb-1.5 text-[9.5px] leading-snug text-white/30">
                {{ showAllFiles ? 'All files on disk.' : 'Media this project uses or generated.' }}
              </div>
              <div
                v-for="file in visibleInputFiles"
                :key="file.path"
                data-testid="asset-row"
                :data-asset-kind="'input-file'"
                class="flex items-center gap-2 px-2 py-1.5 rounded text-xs cursor-grab active:cursor-grabbing hover:bg-white/5 transition-colors"
                draggable="true"
                :title="file.filename + ' — drag onto a track, or click to append'"
                @dragstart="(e) => onAssetDragStart({ kind: 'input-file', path: file.path, filename: file.filename }, e)"
                @click="addFileToTimeline(file)"
              >
                <div class="relative h-8 w-14 shrink-0 rounded overflow-hidden bg-white/5 flex items-center justify-center">
                  <component :is="clipIcon(inputFileKind(file.filename))" class="size-3 text-white/25" />
                  <img class="absolute inset-0 h-full w-full object-cover" loading="lazy" draggable="false"
                    :src="inputThumbUrl(file.filename)" alt="" @error="hideBrokenThumb" />
                </div>
                <component :is="clipIcon(inputFileKind(file.filename))" class="size-3 text-white/40 shrink-0" />
                <span class="truncate">{{ file.filename }}</span>
              </div>
              <div v-if="!visibleInputFiles.length" class="text-xs text-white/30 px-2 py-4 italic">
                {{ inputFiles.length ? 'Nothing in this project references a media file yet.' : 'No media files in input/' }}
              </div>
              <button
                v-if="otherFilesCount > 0"
                class="w-full mt-1 px-2 py-1.5 rounded text-[10px] text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors text-left"
                @click="showAllFiles = !showAllFiles"
              >
                {{ showAllFiles ? '← Back to this project' : `Show ${otherFilesCount} more from other projects…` }}
              </button>
            </template>
            <template v-else>
              <div class="px-2 pb-1.5 text-[9.5px] leading-snug text-white/30">
                Imported into this timeline · dot = on a track.
              </div>
              <div
                v-for="asset in assetsList"
                :key="asset.id"
                class="group flex items-center gap-2 px-2 py-1.5 rounded text-xs cursor-grab active:cursor-grabbing hover:bg-white/5"
                draggable="true"
                :title="asset.name"
                @dragstart="(e) => onAssetDragStart({ kind: 'library', asset_id: asset.id }, e)"
              >
                <div class="relative h-8 w-14 shrink-0 rounded overflow-hidden bg-white/5 flex items-center justify-center">
                  <component :is="clipIcon(asset.kind)" class="size-3 text-white/25" />
                  <img v-if="assetThumb(asset.id)" class="absolute inset-0 h-full w-full object-cover" draggable="false"
                    :src="assetThumb(asset.id)!" alt="" />
                </div>
                <component :is="clipIcon(asset.kind)" class="size-3 text-white/40 shrink-0" />
                <span class="truncate flex-1">{{ asset.name }}</span>
                <!-- In-use dot when this asset is on the timeline -->
                <span
                  v-if="assetUsageCount(asset.id) > 0"
                  class="size-1.5 rounded-full bg-emerald-400/70 shrink-0"
                  :title="`${assetUsageCount(asset.id)} clip${assetUsageCount(asset.id) === 1 ? '' : 's'} on timeline`"
                />
                <span class="text-white/30 tabular-nums text-[10px]">
                  {{ asset.duration_sec ? formatTime(asset.duration_sec) : '' }}
                </span>
              </div>
              <div v-if="!assetsList.length" class="text-xs text-white/30 px-2 py-4 italic">
                Import files from Input Files tab.
              </div>
            </template>
          </div>
        </div>

        <!-- Center: preview canvas -->
        <div class="flex-1 relative flex items-center justify-center overflow-hidden bg-[#080808]">
          <canvas
            ref="canvasRef"
            class="max-w-full max-h-full object-contain ring-1 ring-white/5 rounded bg-black"
            :style="{ aspectRatio: `${store.state.value.canvas.width}/${store.state.value.canvas.height}` }"
          />
          <div class="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-white/40 tabular-nums">
            {{ store.playheadFrame.value }} / {{ store.totalFrames.value }}f
            · {{ formatTime(store.playhead.value) }}
            <span v-if="store.isPlaying.value" class="ml-1 text-white/70">▶</span>
            <span v-else class="ml-1 text-white/25">⏸</span>
          </div>
        </div>

        <!-- Right: inspector -->
        <div class="w-64 border-l border-white/10 shrink-0 overflow-y-auto">
          <div class="px-4 py-3 border-b border-white/10">
            <h3 class="text-sm font-semibold tracking-tight">
              {{ selectedClipData ? 'Clip' : 'Properties' }}
            </h3>
          </div>
          <div v-if="selectedClipData" class="p-3 space-y-3 text-xs">
            <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 flex items-center gap-1.5">
              <component :is="clipIcon(selectedClipData.kind)" class="size-3" />
              {{ selectedClipData.kind }}
            </div>

            <MotionClipInspector
              v-if="selectedMotionClip"
              :clip="selectedMotionClip"
              class="pb-2 border-b border-white/5"
              @update="p => store.updateClip(selectedMotionClip!.id, p)"
            />

            <SpaceTypeClipInspector
              v-if="selectedSpaceTypeClip"
              :clip="selectedSpaceTypeClip"
              :node-state="spaceTypeOriginNodeState"
              class="pb-2 border-b border-white/5"
              @sync="clipId => store.syncSpaceTypeClipFromNode(clipId, spaceTypeOriginNodeState!)"
            />

            <div class="grid grid-cols-2 gap-2">
              <div>
                <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Start</div>
                <div class="flex items-center gap-1.5">
                  <input type="number" step="0.1" min="0" :value="fToS(selectedClipData.start_frame)"
                    class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
                    @change="store.updateClip(selectedClipData!.id, { start_frame: sToF(($event.target as HTMLInputElement).value) })" />
                  <span class="text-[9px] text-white/30 tabular-nums shrink-0">{{ selectedClipData.start_frame }}f</span>
                </div>
              </div>
              <div>
                <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Length</div>
                <div class="flex items-center gap-1.5">
                  <input type="number" step="0.1" min="0" :value="fToS(selectedClipData.length)"
                    class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
                    @change="store.updateClip(selectedClipData!.id, { length: Math.max(1, sToF(($event.target as HTMLInputElement).value)) })" />
                  <span class="text-[9px] text-white/30 tabular-nums shrink-0">{{ selectedClipData.length }}f</span>
                </div>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2">
              <div>
                <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">In point</div>
                <div class="flex items-center gap-1.5">
                  <input type="number" step="0.1" min="0" :value="fToS(selectedClipData.in_frame)"
                    class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
                    @change="store.updateClip(selectedClipData!.id, { in_frame: sToF(($event.target as HTMLInputElement).value) })" />
                  <span class="text-[9px] text-white/30 tabular-nums shrink-0">{{ selectedClipData.in_frame }}f</span>
                </div>
              </div>
              <div />
            </div>

            <template v-if="selectedClipData.kind !== 'audio'">
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">X</div>
                  <input type="number" step="0.01" :value="r(displayTransform?.x ?? 0, 3)"
                    class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
                    @change="store.updateClipTransform(selectedClipData!.id, { x: parseFloat(($event.target as HTMLInputElement).value) || 0 })" />
                </div>
                <div>
                  <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Y</div>
                  <input type="number" step="0.01" :value="r(displayTransform?.y ?? 0, 3)"
                    class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
                    @change="store.updateClipTransform(selectedClipData!.id, { y: parseFloat(($event.target as HTMLInputElement).value) || 0 })" />
                </div>
              </div>

              <div class="grid grid-cols-2 gap-2">
                <div>
                  <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Rotation</div>
                  <input type="number" step="1" :value="r(displayTransform?.rotation ?? 0, 1)"
                    class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
                    @change="store.updateClipTransform(selectedClipData!.id, { rotation: parseFloat(($event.target as HTMLInputElement).value) || 0 })" />
                </div>
                <div>
                  <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Scale</div>
                  <input type="number" step="0.05" :value="r(displayTransform?.scale ?? 1, 3)"
                    class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
                    @change="store.updateClipTransform(selectedClipData!.id, { scale: parseFloat(($event.target as HTMLInputElement).value) || 1 })" />
                </div>
              </div>

              <div>
                <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Opacity</div>
                <div class="flex items-center gap-2">
                  <input type="range" min="0" max="1" step="0.01" :value="displayTransform?.opacity ?? 1"
                    class="flex-1"
                    @pointerdown="store.beginGesture()"
                    @input="store.updateClipTransform(selectedClipData!.id, { opacity: parseFloat(($event.target as HTMLInputElement).value) })" />
                  <span class="text-white/60 w-10 text-right tabular-nums">{{ Math.round((displayTransform?.opacity ?? 1) * 100) }}%</span>
                </div>
              </div>

              <div>
                <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Blend</div>
                <select :value="selectedClipData.blend ?? 'normal'"
                  class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none"
                  @change="store.updateClip(selectedClipData!.id, { blend: ($event.target as HTMLSelectElement).value as BlendMode })">
                  <option v-for="m in BLEND_MODES" :key="m" :value="m">{{ m.replace('_', ' ') }}</option>
                </select>
              </div>

              <!-- Keyframes: animate the transform over the clip's life. -->
              <div class="pt-2 border-t border-white/5">
                <div class="flex items-center justify-between mb-1.5">
                  <div class="text-[10px] uppercase tracking-[0.12em] text-white/40">Keyframes</div>
                  <button
                    class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-white/15 hover:bg-white/20 text-white/70 transition-colors"
                    title="Add / update keyframe at playhead"
                    @click="store.addKeyframe(selectedClipData!.id)"
                  ><Diamond class="size-2.5" /> Add</button>
                </div>
                <div v-if="selectedClipData.keyframes?.length" class="space-y-1">
                  <div
                    v-for="kf in selectedClipData.keyframes"
                    :key="kf.frame"
                    class="flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer transition-colors"
                    :class="store.clipLocalFrame(selectedClipData) === kf.frame ? 'bg-white/15' : 'bg-white/[0.03] hover:bg-white/[0.07]'"
                    @click="seekToKeyframe(selectedClipData!, kf.frame)"
                  >
                    <Diamond class="size-2.5 shrink-0"
                      :class="store.clipLocalFrame(selectedClipData) === kf.frame ? 'text-white' : 'text-white/40'" />
                    <span class="w-9 tabular-nums text-white/70">{{ kf.frame }}f</span>
                    <select :value="kf.ease ?? 'linear'"
                      class="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-1 py-0.5 text-white/80 outline-none text-[10px]"
                      @click.stop
                      @change="store.setKeyframeEase(selectedClipData!.id, kf.frame, ($event.target as HTMLSelectElement).value as any)">
                      <option value="linear">linear</option>
                      <option value="easeInOut">ease</option>
                    </select>
                    <button class="size-4 flex items-center justify-center rounded hover:bg-red-500/20 text-white/40 hover:text-red-300 shrink-0"
                      title="Remove keyframe"
                      @click.stop="store.removeKeyframeAt(selectedClipData!.id, kf.frame)">
                      <Trash2 class="size-2.5" />
                    </button>
                  </div>
                </div>
                <div v-else class="text-[10px] text-white/30 italic leading-snug">
                  Transform is static. Add a keyframe to animate position, scale, rotation &amp; opacity.
                </div>
              </div>
            </template>

            <div v-if="selectedClipData.kind === 'audio' || selectedClipData.kind === 'video'">
              <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Volume</div>
              <div class="flex items-center gap-2">
                <input type="range" min="0" max="2" step="0.01" :value="selectedClipData.volume ?? 1"
                  class="flex-1"
                  @pointerdown="store.beginGesture()"
                  @input="store.updateClip(selectedClipData!.id, { volume: parseFloat(($event.target as HTMLInputElement).value) })" />
                <span class="text-white/60 w-10 text-right tabular-nums">{{ Math.round((selectedClipData.volume ?? 1) * 100) }}%</span>
              </div>
            </div>

            <div v-if="FILTERABLE_KINDS.has(selectedClipData.kind)" class="pt-2 border-t border-white/5">
              <div class="flex items-center justify-between mb-1.5">
                <div class="text-[10px] uppercase tracking-[0.12em] text-white/40">Adjust</div>
                <button
                  v-if="selectedClipData.filters"
                  class="px-1.5 py-0.5 rounded text-[10px] bg-white/5 hover:bg-white/10 text-white/50 hover:text-white/80"
                  @click="resetFilters(selectedClipData!)"
                >Reset</button>
              </div>
              <div v-for="fd in FILTER_DEFS" :key="fd.key" class="flex items-center gap-2 mb-1">
                <span class="w-20 text-[10px] text-white/50">{{ fd.label }}</span>
                <input type="range" :min="fd.min" :max="fd.max" :step="fd.step"
                  :value="filterValue(selectedClipData, fd.key)"
                  class="flex-1"
                  @pointerdown="store.beginGesture()"
                  @input="setFilterValue(selectedClipData!, fd.key, parseFloat(($event.target as HTMLInputElement).value))" />
                <span class="w-10 text-right text-[10px] text-white/60 tabular-nums">
                  {{ fd.key === 'hue' ? filterValue(selectedClipData, fd.key) + '°' : filterValue(selectedClipData, fd.key).toFixed(2) }}
                </span>
              </div>
            </div>

            <div v-if="selectedClipData.kind === 'video' || selectedClipData.kind === 'audio'" class="pt-2 border-t border-white/5">
              <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1.5"
                title="Keyframes are timed to the clip's output frames — they don't move when speed changes.">Speed</div>
              <div class="flex items-center gap-1">
                <button
                  v-for="p in SPEED_PRESETS"
                  :key="p"
                  class="px-1.5 py-1 rounded text-[10px] tabular-nums transition-colors"
                  :class="(selectedClipData.speed ?? 1) === p ? 'bg-white/20 text-white' : 'bg-white/5 hover:bg-white/10 text-white/60'"
                  @click="setClipSpeed(selectedClipData!, p)"
                >{{ p }}×</button>
                <input type="number" min="0.1" max="5" step="0.1" :value="selectedClipData.speed ?? 1"
                  class="w-14 ml-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-1.5 py-1 text-white/90 outline-none tabular-nums text-[11px]"
                  @change="setClipSpeed(selectedClipData!, parseFloat(($event.target as HTMLInputElement).value))" />
              </div>
              <label class="flex items-center gap-1.5 mt-2 text-[11px] text-white/70 cursor-pointer select-none">
                <input type="checkbox" :checked="!!selectedClipData.reverse"
                  @change="store.updateClip(selectedClipData!.id, { reverse: ($event.target as HTMLInputElement).checked })" />
                Reverse
              </label>
            </div>

            <div class="grid grid-cols-2 gap-2 pt-2 border-t border-white/5">
              <div>
                <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Fade in</div>
                <div class="flex items-center gap-1.5">
                  <input type="number" step="0.1" min="0" :value="fToS(selectedClipData.fade_in ?? 0)"
                    class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
                    @change="store.updateClip(selectedClipData!.id, { fade_in: sToF(($event.target as HTMLInputElement).value) })" />
                  <span class="text-[9px] text-white/30 tabular-nums shrink-0">{{ selectedClipData.fade_in ?? 0 }}f</span>
                </div>
              </div>
              <div>
                <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Fade out</div>
                <div class="flex items-center gap-1.5">
                  <input type="number" step="0.1" min="0" :value="fToS(selectedClipData.fade_out ?? 0)"
                    class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
                    @change="store.updateClip(selectedClipData!.id, { fade_out: sToF(($event.target as HTMLInputElement).value) })" />
                  <span class="text-[9px] text-white/30 tabular-nums shrink-0">{{ selectedClipData.fade_out ?? 0 }}f</span>
                </div>
              </div>
            </div>

            <div class="flex gap-2 pt-2 border-t border-white/5">
              <button
                class="flex items-center gap-1 px-2 py-1.5 rounded text-xs bg-white/5 hover:bg-white/10 transition-colors"
                title="Split at playhead (S)"
                @click="store.splitAtPlayhead(selectedClipData!.id)"
              ><Scissors class="size-3" /> Split</button>
              <button
                class="flex items-center gap-1 px-2 py-1.5 rounded text-xs bg-red-500/10 hover:bg-red-500/20 text-red-300 transition-colors"
                title="Delete (Backspace)"
                @click="store.removeClip(selectedClipData!.id)"
              ><Trash2 class="size-3" /> Delete</button>
            </div>
          </div>
          <div v-else class="p-3 space-y-3 text-xs">
            <div class="text-[10px] uppercase tracking-[0.12em] text-white/40">Canvas</div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Width</div>
                <input type="number" :value="store.state.value.canvas.width"
                  class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
                  @change="store.setCanvas({ width: Math.max(16, parseInt(($event.target as HTMLInputElement).value) || 1280) })" />
              </div>
              <div>
                <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Height</div>
                <input type="number" :value="store.state.value.canvas.height"
                  class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
                  @change="store.setCanvas({ height: Math.max(16, parseInt(($event.target as HTMLInputElement).value) || 720) })" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">FPS</div>
                <input type="number" min="1" max="120" :value="store.fps.value"
                  class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-white/90 outline-none tabular-nums"
                  @change="store.setCanvas({ fps: Math.max(1, Math.min(120, parseInt(($event.target as HTMLInputElement).value) || 30)) })" />
              </div>
              <div>
                <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">Background</div>
                <input type="color" :value="store.state.value.canvas.bg_color"
                  class="w-full h-8 bg-[#1a1a1a] border border-[#2a2a2a] rounded outline-none cursor-pointer"
                  @input="store.setCanvas({ bg_color: ($event.target as HTMLInputElement).value })" />
              </div>
            </div>

            <div class="pt-2 border-t border-white/5 text-[10px] uppercase tracking-[0.12em] text-white/40">Stats</div>
            <div class="flex flex-col gap-1 text-white/60 tabular-nums">
              <div class="flex justify-between"><span class="text-white/40">Tracks</span><span>{{ store.state.value.tracks.length }}</span></div>
              <div class="flex justify-between"><span class="text-white/40">Clips</span><span>{{ store.state.value.tracks.reduce((n, t) => n + t.clips.length, 0) }}</span></div>
              <div class="flex justify-between"><span class="text-white/40">Duration</span><span>{{ formatTime(store.totalSec.value) }} <span class="text-white/30">· {{ store.totalFrames.value }}f</span></span></div>
              <div class="flex justify-between"><span class="text-white/40">Zoom</span><span>{{ pxPerFrame.toFixed(2) }}x</span></div>
            </div>

            <div class="text-[10px] text-white/30 italic pt-2 border-t border-white/5">
              Select a clip to edit its properties.
            </div>
          </div>
        </div>
      </div>

      <!-- Bottom: multi-track timeline -->
      <div class="border-t border-white/10 flex flex-col shrink-0"
           :style="{ height: Math.max(220, store.state.value.tracks.length * (TRACK_HEIGHT + TRACK_GAP) + RULER_HEIGHT + 70 + (store.selectedClip.value?.kind === 'motion' ? 158 : 0)) + 'px' }">

        <!-- Transport bar -->
        <div class="flex items-center gap-2 px-4 py-1.5 border-b border-white/5 shrink-0">
          <div class="flex items-center gap-0.5">
            <button class="size-6 flex items-center justify-center rounded hover:bg-white/10 text-white/70 hover:text-white" title="Go to start" @click="store.seek(0)">
              <ChevronsLeft class="size-3.5" />
            </button>
            <button class="size-6 flex items-center justify-center rounded hover:bg-white/10 text-white/70 hover:text-white" title="Step back (←)" @click="store.stepFrames(-1)">
              <SkipBack class="size-3.5" />
            </button>
            <button class="size-7 flex items-center justify-center rounded bg-white/10 hover:bg-white/15 text-white" :title="store.isPlaying.value ? 'Pause (Space)' : 'Play (Space)'" @click="store.togglePlay()">
              <Pause v-if="store.isPlaying.value" class="size-4" />
              <Play v-else class="size-4 translate-x-px" />
            </button>
            <button class="size-6 flex items-center justify-center rounded hover:bg-white/10 text-white/70 hover:text-white" title="Step forward (→)" @click="store.stepFrames(1)">
              <SkipForward class="size-3.5" />
            </button>
            <button class="size-6 flex items-center justify-center rounded hover:bg-white/10 text-white/70 hover:text-white" title="Go to end" @click="store.seek(store.totalSec.value)">
              <ChevronsRight class="size-3.5" />
            </button>
          </div>

          <span class="text-[10px] text-white/40 tabular-nums ml-2 min-w-[110px]">
            {{ formatTime(store.playhead.value) }} <span class="text-white/25">·</span> {{ store.playheadFrame.value }}f
          </span>

          <!-- Zoom controls -->
          <div class="flex items-center gap-0.5 ml-3 border-l border-white/10 pl-3">
            <button class="size-6 flex items-center justify-center rounded hover:bg-white/10 text-white/60 hover:text-white text-sm" title="Zoom out" @click="zoomOut()">−</button>
            <button class="px-2 h-6 rounded hover:bg-white/10 text-white/60 hover:text-white text-[10px] tabular-nums" :title="`Current: ${pxPerFrame.toFixed(2)} px/frame`" @click="zoomFit()">{{ Math.round(pxPerFrame * 100) / 100 }}x</button>
            <button class="size-6 flex items-center justify-center rounded hover:bg-white/10 text-white/60 hover:text-white text-sm" title="Zoom in" @click="zoomIn()">+</button>
            <button class="px-2 h-6 rounded hover:bg-white/10 text-white/60 hover:text-white text-[10px]" title="Fit timeline to width" @click="zoomFit()">Fit</button>
            <button class="size-6 flex items-center justify-center rounded transition-colors ml-1"
              :class="snapEnabled ? 'bg-white/15 text-white' : 'hover:bg-white/10 text-white/40'"
              :title="snapEnabled ? 'Snapping on (Alt bypasses)' : 'Snapping off (Alt snaps)'"
              @click="toggleSnap"><Magnet class="size-3.5" /></button>
            <button class="size-6 flex items-center justify-center rounded transition-colors"
              :class="rippleEnabled ? 'bg-white/15 text-white' : 'hover:bg-white/10 text-white/40'"
              :title="rippleEnabled ? 'Ripple on: trimming or deleting moves the later clips' : 'Ripple off: trimming or deleting leaves the later clips where they are'"
              @click="toggleRipple"><FoldHorizontal class="size-3.5" /></button>
          </div>

          <!-- Edit actions -->
          <div class="flex items-center gap-0.5 ml-3 border-l border-white/10 pl-3">
            <button class="size-6 flex items-center justify-center rounded hover:bg-white/10 text-white/60 hover:text-white disabled:opacity-30"
              :disabled="!store.selectedClipId.value" title="Split at playhead (S)"
              @click="store.selectedClipId.value && store.splitAtPlayhead(store.selectedClipId.value)"><Scissors class="size-3.5" /></button>
            <button class="size-6 flex items-center justify-center rounded hover:bg-red-500/20 text-white/60 hover:text-red-300 disabled:opacity-30"
              :disabled="!selectedClipIds.size" title="Delete selected (⌫)"
              @click="deleteSelection()"><Trash2 class="size-3.5" /></button>
          </div>

          <div class="ml-auto flex items-center gap-2">
            <button
              class="flex items-center gap-1 px-2 h-6 rounded text-[10px] bg-white/5 hover:bg-white/10 transition-colors"
              @click="store.addTrack('video')"
            ><Plus class="size-3" /> Video track</button>
            <button
              class="flex items-center gap-1 px-2 h-6 rounded text-[10px] bg-white/5 hover:bg-white/10 transition-colors"
              @click="store.addTrack('audio')"
            ><Plus class="size-3" /> Audio track</button>
          </div>
        </div>

        <!-- Track lanes -->
        <div class="flex flex-1 min-h-0 overflow-y-auto">
          <!-- Track headers -->
          <div class="w-36 shrink-0 border-r border-white/10">
            <!-- Spacer to align with ruler -->
            <div :style="{ height: RULER_HEIGHT + 'px' }" class="border-b border-white/5" />
            <div
              v-for="(track, tIdx) in store.state.value.tracks"
              :key="track.id"
              class="relative flex items-center gap-1.5 px-2 border-b border-white/5 cursor-grab active:cursor-grabbing select-none"
              :class="reorderingTrackId === track.id ? 'bg-white/[0.06] z-10' : ''"
              :style="{ height: trackHeight(track) + 'px' }"
              @pointerdown="(e) => onTrackReorderStart(track.id, e)"
              @contextmenu="(e) => onHeaderContextMenu(track.id, e)"
            >
              <component :is="track.kind === 'audio' ? Music : Film" class="size-3" :class="trackColor(tIdx).text" />
              <input v-if="renamingTrackId === track.id"
                class="flex-1 min-w-0 bg-[#1a1a1a] border border-white/20 rounded px-1 py-0.5 text-[11px] text-white/90 outline-none"
                :value="track.name" autofocus
                @pointerdown.stop
                @keydown.enter="(e) => commitTrackName(track.id, (e.target as HTMLInputElement).value)"
                @keydown.escape="renamingTrackId = null"
                @blur="(e) => commitTrackName(track.id, (e.target as HTMLInputElement).value)" />
              <span v-else class="text-[11px] truncate flex-1" :class="trackColor(tIdx).text"
                @dblclick="renamingTrackId = track.id">{{ track.name }}</span>
              <button class="size-4 flex items-center justify-center rounded hover:bg-white/10"
                :title="track.muted ? 'Unmute' : 'Mute'"
                @pointerdown.stop
                @click.stop="store.mutate(s => { const t = s.tracks.find(t2 => t2.id === track.id); if (t) t.muted = !t.muted })">
                <component :is="track.kind === 'audio' ? (track.muted ? VolumeX : Volume2) : (track.muted ? EyeOff : Eye)" class="size-2.5 text-white/40" />
              </button>
              <button class="size-4 flex items-center justify-center rounded hover:bg-white/10"
                :title="track.locked ? 'Unlock' : 'Lock'"
                @pointerdown.stop
                @click.stop="store.mutate(s => { const t = s.tracks.find(t2 => t2.id === track.id); if (t) t.locked = !t.locked })">
                <component :is="track.locked ? Lock : Unlock" class="size-2.5 text-white/40" />
              </button>
              <!-- Resize handle at bottom edge -->
              <div
                class="absolute left-0 right-0 bottom-0 h-1 cursor-row-resize hover:bg-white/20"
                data-role="resize"
                @pointerdown="(e) => onTrackResizeStart(track.id, e)"
              />
            </div>
          </div>

          <!-- Clip strips -->
          <div
            ref="stripRef"
            class="strip-bg relative flex-1 select-none touch-none overflow-hidden"
            @pointerdown="onStripPointerDown"
            @wheel="onStripWheel"
          >
            <!-- Ruler with time labels — owns playhead scrubbing -->
            <div class="relative border-b border-white/10 cursor-col-resize"
                 :style="{ height: RULER_HEIGHT + 'px' }"
                 @pointerdown="onPlayheadPointerDown">
              <template v-for="t in ticks" :key="`ruler-${t.frame}`">
                <div
                  class="absolute top-0 border-l pointer-events-none"
                  :class="t.major ? 'h-3 border-white/30' : 'h-1.5 border-white/15'"
                  :style="{ left: framesToPx(t.frame) + 'px' }"
                />
                <div
                  v-if="t.major && t.label"
                  class="absolute top-2.5 text-[9px] text-white/50 tabular-nums px-0.5 pointer-events-none"
                  :style="{ left: (framesToPx(t.frame) + 2) + 'px' }"
                >{{ t.label }}</div>
              </template>
            </div>

            <!-- Minor tick verticals through track lanes -->
            <div class="absolute pointer-events-none" :style="{ top: RULER_HEIGHT + 'px', left: 0, right: 0, bottom: 0 }">
              <template v-for="t in ticks" :key="`vtick-${t.frame}`">
                <div
                  v-if="t.major"
                  class="absolute top-0 bottom-0 border-l"
                  :class="'border-white/[0.08]'"
                  :style="{ left: framesToPx(t.frame) + 'px' }"
                />
              </template>
            </div>

            <!-- Clips per track -->
            <div
              v-for="(track, tIdx) in store.state.value.tracks"
              :key="track.id"
              data-lane
              class="relative border-b border-white/5"
              :class="[
                dragTargetTrackId === track.id ? 'bg-white/[0.04]' : '',
                moveTargetTrackId === track.id ? 'bg-white/[0.06]' : '',
              ]"
              :style="{ height: trackHeight(track) + 'px' }"
              @dragover="(e) => onTrackDragOver(track.id, e)"
              @dragleave="onTrackDragLeave"
              @drop="(e) => onTrackDrop(track.id, e)"
              @contextmenu="(e) => onLaneContextMenu(track.id, e)"
            >
              <div
                v-for="clip in track.clips"
                :key="clip.id"
                class="absolute top-1 rounded transition-shadow cursor-grab active:cursor-grabbing overflow-hidden"
                :class="[
                  trackColor(tIdx).bar,
                  selectedClipIds.has(clip.id) ? `ring-2 ${trackColor(tIdx).ring} z-[2]` : '',
                  store.selectedClipId.value === clip.id && selectedClipIds.size > 1 ? 'ring-offset-1 ring-offset-yellow-300' : '',
                ]"
                :style="{
                  left: framesToPx(clip.start_frame) + 'px',
                  width: Math.max(8, clip.length * pxPerFrame) + 'px',
                  height: (trackHeight(track) - 8) + 'px',
                }"
                @pointerdown="(e) => onClipPointerDown(clip.id, track.id, 'move', e)"
                @click.stop
                @contextmenu="(e) => onClipContextMenu(clip.id, e)"
              >
                <!-- Filmstrip backdrop (video/image clips) -->
                <div
                  v-if="clip.kind === 'video' || clip.kind === 'image'"
                  class="absolute inset-0 flex overflow-hidden rounded pointer-events-none"
                >
                  <div
                    v-for="(thumb, idx) in clipThumbs(clip)"
                    :key="idx"
                    class="h-full shrink-0 bg-cover bg-center opacity-90"
                    :style="{
                      backgroundImage: `url(${thumb})`,
                      width: (clip.length * pxPerFrame / Math.max(1, clipThumbs(clip).length)) + 'px',
                    }"
                  />
                </div>
                <!-- Waveform (audio clips) -->
                <svg
                  v-else-if="clip.kind === 'audio' && clipWaveform(clip)"
                  class="absolute inset-x-0 bottom-0 pointer-events-none"
                  :width="Math.max(8, clip.length * pxPerFrame)"
                  :height="trackHeight(track) - 8"
                  preserveAspectRatio="none"
                >
                  <path
                    :d="waveformPath(clipWaveform(clip)!, Math.max(8, clip.length * pxPerFrame), trackHeight(track) - 8)"
                    fill="rgba(0,0,0,0.35)"
                  />
                </svg>
                <!-- Tint overlay so the label stays legible -->
                <div class="absolute inset-0 bg-gradient-to-b from-black/0 via-black/0 to-black/20 pointer-events-none rounded" />
                <!-- Label -->
                <div class="absolute top-0 left-0 right-0 px-2 py-0.5 flex items-center text-[10px] text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)] font-medium select-none pointer-events-none truncate z-[1]"
                  :title="clip.length + 'f'">
                  <component :is="clipIcon(clip.kind)" class="size-2.5 mr-1 opacity-80" />
                  <span class="truncate">{{ clip.kind === 'workflow' ? `Port ${(clip as any).port_index}` : ((clip as any).asset_id ? (assetsList.find(a => a.id === (clip as any).asset_id)?.name ?? clip.kind) : clip.kind) }}</span>
                  <span class="ml-auto text-white/70 tabular-nums shrink-0">{{ (clip.length / store.fps.value).toFixed(1) }}s</span>
                </div>
                <!-- Left resize handle -->
                <div
                  class="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize rounded-l z-10"
                  :class="trackColor(tIdx).edge"
                  @pointerdown.stop="(e) => onClipPointerDown(clip.id, track.id, 'resize-left', e)"
                />
                <!-- Right resize handle -->
                <div
                  class="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize rounded-r z-10"
                  :class="trackColor(tIdx).edge"
                  @pointerdown.stop="(e) => onClipPointerDown(clip.id, track.id, 'resize-right', e)"
                />
                <!-- Fade ramps -->
                <svg v-if="(clip.fade_in ?? 0) > 0" class="absolute left-0 top-0 bottom-0 pointer-events-none z-[1]"
                  :width="Math.min(clip.length, clip.fade_in ?? 0) * pxPerFrame" :height="trackHeight(track) - 8" preserveAspectRatio="none">
                  <polygon :points="`0,${trackHeight(track) - 8} ${Math.min(clip.length, clip.fade_in ?? 0) * pxPerFrame},0 0,0`" fill="rgba(0,0,0,0.45)" />
                </svg>
                <svg v-if="(clip.fade_out ?? 0) > 0" class="absolute right-0 top-0 bottom-0 pointer-events-none z-[1]"
                  :width="Math.min(clip.length, clip.fade_out ?? 0) * pxPerFrame" :height="trackHeight(track) - 8" preserveAspectRatio="none">
                  <polygon :points="`${Math.min(clip.length, clip.fade_out ?? 0) * pxPerFrame},${trackHeight(track) - 8} 0,0 ${Math.min(clip.length, clip.fade_out ?? 0) * pxPerFrame},0`" fill="rgba(0,0,0,0.45)" />
                </svg>
                <!-- Fade handles (selected clip) -->
                <template v-if="selectedClipIds.has(clip.id)">
                  <div class="absolute top-0 size-2.5 rounded-full bg-white/90 border border-black/60 cursor-ew-resize z-20 -translate-y-1/2"
                    :style="{ left: ((clip.fade_in ?? 0) * pxPerFrame - 5) + 'px' }"
                    title="Fade in — drag"
                    @pointerdown="(e) => onFadePointerDown(clip.id, 'in', e)" />
                  <div class="absolute top-0 size-2.5 rounded-full bg-white/90 border border-black/60 cursor-ew-resize z-20 -translate-y-1/2"
                    :style="{ right: ((clip.fade_out ?? 0) * pxPerFrame - 5) + 'px' }"
                    title="Fade out — drag"
                    @pointerdown="(e) => onFadePointerDown(clip.id, 'out', e)" />
                </template>
                <!-- Keyframe diamonds (selected clip) — click to seek, drag to retime -->
                <div
                  v-if="selectedClipIds.has(clip.id) && clip.keyframes?.length"
                  class="absolute left-0 right-0 bottom-0 h-2.5 pointer-events-none z-20"
                >
                  <div
                    v-for="kf in clip.keyframes"
                    :key="kf.frame"
                    class="absolute bottom-px size-2 rotate-45 border border-black/50 shadow-sm pointer-events-auto cursor-grab active:cursor-grabbing -translate-x-1/2"
                    :class="store.playheadFrame.value - clip.start_frame === kf.frame ? 'bg-yellow-300' : 'bg-white/80 hover:bg-white'"
                    :style="{ left: (kf.frame * pxPerFrame) + 'px' }"
                    :title="`Keyframe @ ${kf.frame}f · drag to retime, click to seek`"
                    @pointerdown.stop="(e) => onKeyframePointerDown(clip.id, kf.frame, e)"
                  />
                </div>
              </div>

              <!-- Transition chips at exact junctions -->
              <button
                v-for="j in junctionsFor(track)"
                :key="`jx-${j.fromId}-${j.toId}`"
                class="absolute z-[6] size-4 rounded border flex items-center justify-center text-[9px] leading-none transition-colors"
                :class="j.transition
                  ? 'bg-fuchsia-500/80 border-fuchsia-200/80 text-white'
                  : 'bg-black/70 border-white/25 text-white/40 hover:border-white/60 hover:text-white/80'"
                :style="{ left: (framesToPx(j.frame) - 8) + 'px', top: '50%', marginTop: '-8px' }"
                :title="j.transition ? `${j.transition.kind} · ${(j.transition.duration / store.fps.value).toFixed(1)}s` : 'Add transition'"
                @pointerdown.stop
                @click.stop="openTransitionPopover(j, $event)"
              >◈</button>
            </div>

            <!-- Marquee selection rectangle -->
            <div v-if="marquee"
              class="absolute z-[5] border border-white/50 bg-white/10 pointer-events-none"
              :style="{
                left: Math.min(marquee.x0, marquee.x1) + 'px',
                top: Math.min(marquee.y0, marquee.y1) + 'px',
                width: Math.abs(marquee.x1 - marquee.x0) + 'px',
                height: Math.abs(marquee.y1 - marquee.y0) + 'px',
              }" />

            <!-- Snap guideline (during clip drag) — fuchsia so it reads against
                 the white clip bars (and matches timeline.spec.ts). -->
            <div
              v-if="snapGuideFrame !== null"
              class="absolute pointer-events-none z-[3] w-px bg-fuchsia-400/80 shadow-[0_0_4px_rgba(232,121,249,0.6)]"
              :style="{ top: 0, bottom: 0, left: framesToPx(snapGuideFrame) + 'px' }"
            />

            <!-- Drop ghost (during asset drag-in) -->
            <div
              v-if="dragGhostFrame !== null"
              class="absolute pointer-events-none z-[3] w-0.5 bg-white/80 shadow-[0_0_4px_rgba(255,255,255,0.5)]"
              :style="{ top: RULER_HEIGHT + 'px', bottom: 0, left: framesToPx(dragGhostFrame) + 'px' }"
            />

            <!-- Playhead -->
            <div
              class="absolute top-0 bottom-0 w-px bg-yellow-400 pointer-events-none z-[4]"
              :style="{ left: framesToPx(store.playheadFrame.value) + 'px' }"
            >
              <div class="absolute -top-px -left-1 w-2 h-2 bg-yellow-400 rotate-45" />
            </div>
          </div>
        </div>

        <KeyframeDock :px-per-frame="pxPerFrame" :scroll-x="scrollX" />

        <!-- Keyboard hint strip -->
        <div class="flex items-center gap-3 px-4 h-6 border-t border-white/5 text-[9px] text-white/35 tabular-nums shrink-0">
          <span><kbd class="px-1 py-px rounded bg-white/5 border border-white/10">Space</kbd> play</span>
          <span><kbd class="px-1 py-px rounded bg-white/5 border border-white/10">S</kbd> split</span>
          <span><kbd class="px-1 py-px rounded bg-white/5 border border-white/10">⌘C/V/D</kbd> copy·paste·dup</span>
          <span><kbd class="px-1 py-px rounded bg-white/5 border border-white/10">⌘A</kbd> all</span>
          <span><kbd class="px-1 py-px rounded bg-white/5 border border-white/10">⌫</kbd> delete</span>
          <span><kbd class="px-1 py-px rounded bg-white/5 border border-white/10">⌘Z</kbd> undo</span>
          <span class="ml-auto"><kbd class="px-1 py-px rounded bg-white/5 border border-white/10">⌥</kbd> free-drag</span>
          <span><kbd class="px-1 py-px rounded bg-white/5 border border-white/10">⌘+scroll</kbd> zoom</span>
          <span><kbd class="px-1 py-px rounded bg-white/5 border border-white/10">⇧+scroll</kbd> pan</span>
        </div>
      </div>

      <!-- Trim HUD bubble -->
      <div v-if="trimHud" class="fixed z-[140] px-2 py-1 rounded bg-black/85 border border-white/15 text-[10px] text-white/90 tabular-nums pointer-events-none"
        :style="{ left: trimHud.x + 'px', top: trimHud.y + 'px' }">{{ trimHud.text }}</div>

      <!-- Context menu -->
      <TimelineContextMenu v-if="ctxMenu" v-bind="ctxMenu" @close="ctxMenu = null" />

      <!-- Transition popover -->
      <div v-if="trPopover" class="fixed inset-0 z-[132]" @pointerdown.self="trPopover = null">
        <div
          class="absolute w-52 bg-[#161616] border border-white/10 rounded-lg shadow-2xl p-2.5 text-xs"
          :style="{
            left: Math.max(8, Math.min(trPopover.x - 104, windowWidth() - 220)) + 'px',
            top: Math.max(8, trPopover.y - 170) + 'px',
          }"
        >
          <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1.5">Transition</div>
          <div class="grid grid-cols-2 gap-1">
            <button
              class="px-2 py-1.5 rounded text-[11px] text-left transition-colors"
              :class="!trPopover.junction.transition ? 'bg-white/15 text-white' : 'bg-white/5 hover:bg-white/10 text-white/60'"
              @click="setJunctionKind(null)"
            >None</button>
            <button
              v-for="k in TRANSITION_KINDS"
              :key="k.kind"
              class="px-2 py-1.5 rounded text-[11px] text-left transition-colors"
              :class="trPopover.junction.transition?.kind === k.kind ? 'bg-fuchsia-500/30 text-white' : 'bg-white/5 hover:bg-white/10 text-white/60'"
              @click="setJunctionKind(k.kind)"
            >{{ k.label }}</button>
          </div>
          <div v-if="trPopover.junction.transition" class="flex items-center gap-2 mt-2 pt-2 border-t border-white/5">
            <span class="text-[10px] uppercase tracking-[0.12em] text-white/40">Duration</span>
            <input type="number" min="0.1" max="5" step="0.1"
              :value="(trPopover.junction.transition.duration / store.fps.value).toFixed(1)"
              class="w-16 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-1.5 py-1 text-white/90 outline-none tabular-nums text-[11px]"
              @change="setJunctionDuration(($event.target as HTMLInputElement).value)" />
            <span class="text-white/40 text-[10px]">s</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
