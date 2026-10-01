/**
 * Frame light layers, stage 1: the geometry of the on-canvas light dots (Task 3). Pure — the
 * dots component (`LightHandles.vue`) and the toolbar's placement read it; no Vue, no DOM.
 *
 * Every position is a fraction of the Frame (x of its width, y of its height), allowed
 * −0.5..1.5 so a dot may sit up to half a Frame outside the artboard. Pixel helpers take the
 * artboard's displayed size (`canvasDisplay`).
 */
import type { LightLayer, LightType } from './settings'

export interface Size { w: number; h: number }
export interface Pt { x: number; y: number }

export const LIGHT_POS_MIN = -0.5
export const LIGHT_POS_MAX = 1.5

/** Clamp one position fraction to the light range (−0.5..1.5); junk becomes the centre. */
export function clampLightPos(v: number): number {
  if (!Number.isFinite(v)) return 0.5
  return Math.min(LIGHT_POS_MAX, Math.max(LIGHT_POS_MIN, v))
}

/** The light's dot, in artboard px. */
export function lightDotPos(layer: Pick<LightLayer, 'x' | 'y'>, d: Size): Pt {
  return { x: layer.x * d.w, y: layer.y * d.h }
}

/** A spot's aim ring, in artboard px; null for a lamp or a sun. */
export function aimPos(layer: Pick<LightLayer, 'light'>, d: Size): Pt | null {
  if (layer.light.type !== 'spot') return null
  return { x: layer.light.aimX * d.w, y: layer.light.aimY * d.h }
}

/** A sun's dashed line, from its dot toward the Frame centre (the way its light travels), in
 *  artboard px; null for a lamp or a spot, or a sun sitting on the centre (no direction). */
export function sunLine(layer: Pick<LightLayer, 'x' | 'y' | 'light'>, d: Size): { x1: number; y1: number; x2: number; y2: number } | null {
  if (layer.light.type !== 'sun') return null
  const a = lightDotPos(layer, d)
  const c = { x: 0.5 * d.w, y: 0.5 * d.h }
  if (Math.hypot(c.x - a.x, c.y - a.y) < 1e-6) return null
  return { x1: a.x, y1: a.y, x2: c.x, y2: c.y }
}

/** A pointer's position as Frame fractions, clamped to the light range. `rect` is the
 *  artboard's on-screen box (getBoundingClientRect — it already carries the pan/zoom). */
export function pointerToLightPos(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): Pt {
  return {
    x: clampLightPos((clientX - rect.left) / Math.max(1e-6, rect.width)),
    y: clampLightPos((clientY - rect.top) / Math.max(1e-6, rect.height)),
  }
}

/** Arrow-key nudge on a focused dot, in Frame fractions: 1% a press, 5% with Shift. Null for
 *  any other key. */
export function nudgeForKey(key: string, shift: boolean): Pt | null {
  const s = shift ? 0.05 : 0.01
  switch (key) {
    case 'ArrowLeft': return { x: -s, y: 0 }
    case 'ArrowRight': return { x: s, y: 0 }
    case 'ArrowUp': return { x: 0, y: -s }
    case 'ArrowDown': return { x: 0, y: s }
    default: return null
  }
}

/** Scroll over a dot changes its Height (0..1): scrolling up raises it. */
export function heightFromWheel(height: number, deltaY: number): number {
  const h = height - deltaY * 0.001
  return Math.min(1, Math.max(0, Number.isFinite(h) ? h : height))
}

/** Where a new light lands: a lamp top left of the Frame, a spot top centre aiming at the
 *  middle, a sun at the left edge. */
export const LIGHT_PLACEMENT: Record<LightType, { x: number; y: number; aimX?: number; aimY?: number }> = {
  lamp: { x: 0.12, y: 0.08 },
  spot: { x: 0.5, y: 0.04, aimX: 0.5, aimY: 0.55 },
  sun: { x: 0.02, y: 0.35 },
}
