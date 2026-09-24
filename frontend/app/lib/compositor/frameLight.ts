/**
 * The Frame's one light. Every Gold foil and Spot UV finish on a Frame is lit from here, as
 * real print is — one room, one lamp. Stored on the Frame node as `sailor_localLight`; absent
 * means DEFAULT_FRAME_LIGHT, so a Frame that never touched a finish stores nothing.
 */
export interface FrameLight {
  /** Fractions of the Frame, 0,0 = top left. May sit up to half a Frame past an edge. */
  x: number
  y: number
  /** 0 = grazing the card, 1 = high overhead. */
  height: number
}

export type LightPreset = 'top_left' | 'top_right' | 'overhead' | 'raking'

export const LIGHT_PRESETS: Record<LightPreset, FrameLight> = {
  top_left: { x: 0.15, y: 0.1, height: 0.6 },
  top_right: { x: 0.85, y: 0.1, height: 0.6 },
  overhead: { x: 0.5, y: 0.4, height: 1 },
  raking: { x: -0.3, y: 0.35, height: 0.12 },
}
export const LIGHT_PRESET_LABELS: Record<LightPreset, string> = {
  top_left: 'Top left', top_right: 'Top right', overhead: 'Overhead', raking: 'Raking',
}
export const DEFAULT_FRAME_LIGHT: FrameLight = { ...LIGHT_PRESETS.top_left }

const clamp = (v: unknown, lo: number, hi: number, fb: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb

export function sanitizeLight(raw: unknown): FrameLight {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    x: clamp(r.x, -0.5, 1.5, DEFAULT_FRAME_LIGHT.x),
    y: clamp(r.y, -0.5, 1.5, DEFAULT_FRAME_LIGHT.y),
    height: clamp(r.height, 0, 1, DEFAULT_FRAME_LIGHT.height),
  }
}

export function readFrameLight(props: unknown): FrameLight {
  return sanitizeLight((props as Record<string, unknown> | undefined)?.sailor_localLight)
}

export function presetOf(l: FrameLight): LightPreset | null {
  for (const [k, p] of Object.entries(LIGHT_PRESETS) as [LightPreset, FrameLight][]) {
    if (Math.abs(p.x - l.x) < 1e-6 && Math.abs(p.y - l.y) < 1e-6 && Math.abs(p.height - l.height) < 1e-6) return k
  }
  return null
}

/** The light in the finish shaders' world space: Frame width 1, centred on the origin,
 *  y up, spanning ±aspect/2 vertically (aspect = h / w); camera at z = 2.6. Height 0..1
 *  lifts the lamp from z 0.3 (raking) to z 2.0 (overhead). */
export function lightWorld(l: FrameLight, aspect: number): [number, number, number] {
  return [l.x - 0.5, (0.5 - l.y) * aspect, 0.3 + l.height * 1.7]
}
