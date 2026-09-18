// Pure timeline view-math for the DialKit-emulated Frame motion timeline (Slice 6d).
// Ported verbatim from dialkit TimelineSection.svelte (MIT). Zero Vue/compositor coupling.

const MAJOR_TICK_TARGET_PX = 140
const MILLISECOND_STEP = 0.001
const MIN_TIMELINE_MAX_ZOOM = 8
const ZOOM_DRAG_DISTANCE = 180
const SECOND_TICK_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600,
]
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export interface View { zoom: number; viewStart: number }
export interface Derived { visibleDuration: number; safeViewStart: number; viewEnd: number; pxPerSecond: number; maxZoom: number }

export function clampViewStart(start: number, duration: number, shownDuration: number): number {
  return clamp(start, 0, Math.max(0, duration - shownDuration))
}

export function deriveView(view: View, duration: number, laneWidth: number): Derived {
  const visibleDuration = duration > 0 ? duration / view.zoom : duration
  const safeViewStart = clampViewStart(view.viewStart, duration, visibleDuration)
  const viewEnd = safeViewStart + visibleDuration
  const pxPerSecond = visibleDuration > 0 && laneWidth > 0 ? laneWidth / visibleDuration : 0
  const maxZoom = Math.max(
    MIN_TIMELINE_MAX_ZOOM,
    laneWidth > 0 && duration > 0
      ? (MAJOR_TICK_TARGET_PX * duration) / (MILLISECOND_STEP * 10 * laneWidth)
      : MIN_TIMELINE_MAX_ZOOM,
  )
  return { visibleDuration, safeViewStart, viewEnd, pxPerSecond, maxZoom }
}

export function timeToX(time: number, d: Derived): number { return (time - d.safeViewStart) * d.pxPerSecond }
export function xToTime(x: number, d: Derived): number { return d.pxPerSecond > 0 ? d.safeViewStart + x / d.pxPerSecond : d.safeViewStart }

export function zoomAboutPivot(view: View, duration: number, laneWidth: number, dx: number, anchorRatio: number, anchorTime: number): View {
  const { maxZoom } = deriveView(view, duration, laneWidth)
  const nextZoom = clamp(view.zoom * Math.exp(dx / ZOOM_DRAG_DISTANCE), 1, maxZoom)
  const nextDuration = duration / nextZoom
  const viewStart = clampViewStart(anchorTime - anchorRatio * nextDuration, duration, nextDuration)
  return { zoom: nextZoom, viewStart }
}

export interface Ticks { major: number[]; medium: number[]; fine: number[]; majorStep: number }
export function computeTicks(d: Derived, zoom: number, duration: number): Ticks {
  const rawStep = d.pxPerSecond > 0 ? MAJOR_TICK_TARGET_PX / d.pxPerSecond : 1
  const adaptive = SECOND_TICK_STEPS.find((s) => s >= rawStep) ?? SECOND_TICK_STEPS[SECOND_TICK_STEPS.length - 1]!
  const majorStep = zoom < 1.5 && duration >= 1 ? Math.max(1, adaptive) : adaptive
  const fineStep = majorStep / 10
  const major: number[] = []
  const medium: number[] = []
  const fine: number[] = []
  const firstMajor = Math.ceil((d.safeViewStart - 1e-6) / majorStep) * majorStep
  for (let time = firstMajor; time <= d.viewEnd + 1e-6; time += majorStep) major.push(Number(time.toFixed(4)))
  const firstFine = Math.ceil((d.safeViewStart - 1e-6) / fineStep)
  const lastFine = Math.floor((d.viewEnd + 1e-6) / fineStep)
  for (let index = firstFine; index <= lastFine; index++) {
    if (index % 10 === 0) continue
    const tick = Number((index * fineStep).toFixed(6))
    if (index % 5 === 0) medium.push(tick); else fine.push(tick)
  }
  return { major, medium, fine, majorStep }
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
export function formatRulerSeconds(time: number, step: number): string {
  if (step >= 1 && Number.isInteger(time)) return formatClock(time)
  const decimals = Math.min(3, Math.max(1, Math.ceil(-Math.log10(step))))
  return `${time.toFixed(decimals)}s`
}
