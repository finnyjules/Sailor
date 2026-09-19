// Curve-editor geometry, ported from DialKit's easing-geometry.ts (MIT, joshpuckett/dialkit).
// Pure: fits a cubic-bézier into a box with EQUAL axis scale (the 0→1 reference stays at 45°
// even during overshoot), and turns pointer / arrow-key deltas into new handles.
import type { BezierEase } from './types'

export interface GraphPoint { x: number; y: number }

const clampY = (v: number) => Math.max(-1, Math.min(2, v))

export function formatEase(ease: BezierEase): string {
  return ease.join(', ')
}

export function parseEase(text: string): BezierEase | null {
  const parts = text.split(',').map((p) => p.trim())
  if (parts.length !== 4 || parts.some((p) => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(p))) return null
  const v = parts.map(Number)
  if (!v.every(Number.isFinite) || v[0]! < 0 || v[0]! > 1 || v[2]! < 0 || v[2]! > 1) return null
  v[1] = clampY(v[1]!)
  v[3] = clampY(v[3]!)
  return v as BezierEase
}

/** Defensive rendering for stored values; valid overshoot is never clamped. */
export function normalizeEase(ease: BezierEase): BezierEase {
  return ease.map((value, i) => {
    const finite = Number.isFinite(value) ? value : (i < 2 ? 0 : 1)
    return i % 2 === 0 ? Math.max(0, Math.min(1, finite)) : finite
  }) as BezierEase
}

export function fitEasingGraph(ease: BezierEase, width: number, height: number) {
  const value = normalizeEase(ease)
  // The 24px handle target can reach the edge without clipping its circle or focus ring.
  const padding = Math.min(12, width / 4, height / 4)
  const radiusY = Math.max(0.5, Math.abs(value[1] - 0.5), Math.abs(value[3] - 0.5))
  const unit = Math.min(width - padding * 2, (height / 2 - padding) / radiusY)
  const scale = { x: unit, y: unit }
  const project = (x: number, y: number): GraphPoint => ({
    x: width / 2 + (x - 0.5) * scale.x,
    y: height / 2 - (y - 0.5) * scale.y,
  })
  return {
    scale, start: project(0, 0), end: project(1, 1),
    handles: [project(value[0], value[1]), project(value[2], value[3])] as [GraphPoint, GraphPoint],
  }
}

/** Deltas use the pointer-down scale so refitting the display cannot amplify a drag. */
export function moveEasingHandle(ease: BezierEase, handle: 0 | 1, dx: number, dy: number, scale: GraphPoint): BezierEase {
  const next = [...ease] as BezierEase
  if (!Number.isFinite(scale.x) || !Number.isFinite(scale.y) || scale.x <= 0 || scale.y <= 0) return next
  const i = handle * 2
  const x = ease[i]! + dx / scale.x
  const y = ease[i + 1]! - dy / scale.y
  if (dx !== 0) next[i] = Number(Math.max(0, Math.min(1, x)).toFixed(2))
  if (dy !== 0 && Number.isFinite(y)) next[i + 1] = Number(clampY(y).toFixed(2))
  return next
}

export function easingHandleFromKey(ease: BezierEase, handle: 0 | 1, key: string, shift: boolean): BezierEase | undefined {
  const d = shift ? 0.1 : 0.01
  const scale = { x: 1, y: 1 }
  if (key === 'ArrowLeft') return moveEasingHandle(ease, handle, -d, 0, scale)
  if (key === 'ArrowRight') return moveEasingHandle(ease, handle, d, 0, scale)
  if (key === 'ArrowUp') return moveEasingHandle(ease, handle, 0, -d, scale)
  if (key === 'ArrowDown') return moveEasingHandle(ease, handle, 0, d, scale)
}

/** Stop the tangent at the handle's outer radius, including when the handle meets an endpoint. */
export function easingGuideEnd(start: GraphPoint, handle: GraphPoint, radius = 5): GraphPoint {
  const dx = handle.x - start.x
  const dy = handle.y - start.y
  const distance = Math.hypot(dx, dy)
  if (distance <= radius) return { ...start }
  return { x: handle.x - (dx / distance) * radius, y: handle.y - (dy / distance) * radius }
}
