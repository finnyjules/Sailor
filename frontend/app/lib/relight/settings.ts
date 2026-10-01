/**
 * Relight: the stored shape of the effect. Since Frame light layers stage 2 the effect holds
 * only how the photo takes light (Original light, Depth, Texture, Shine, Shadows); the lights
 * themselves are the Frame's light layers (lib/frame/lighting). Old saved effects still carry a
 * `lights` list — `RelightLight`, positions in fractions of the LAYER box (0,0 = its top left,
 * may sit past its edges), height below 0 = behind the subject (rim light). Only the
 * conversion (lib/frame/lighting/convertRelight) reads them, through `readLegacyRelightLights`.
 * Specs: docs/superpowers/specs/2026-09-30-relight-layer-effect-design.md,
 * docs/superpowers/specs/2026-10-01-frame-light-layers-design.md
 */
export interface RelightLight {
  id: string
  x: number
  y: number
  height: number
  color: string
  brightness: number
  reach: number
  on: boolean
}

export interface RelightEffect {
  type: 'relight'
  visible: boolean
  /** Original light: how much of the photo's own lighting stays as the base level. */
  keep: number
  /** Depth: how strongly the photo's shape bends the light. */
  depth: number
  /** Texture: fine relief taken from the photo itself. */
  texture: number
  /** Shine: glossy highlights. */
  shine: number
  /** Shadows: short contact shadows. */
  shadows: boolean
}

export const RELIGHT_MAX_LIGHTS = 3

export const RELIGHT_SWATCHES: readonly { label: string; color: string }[] = [
  { label: 'Warm', color: '#ffcf94' },
  { label: 'Tungsten', color: '#ffb36b' },
  { label: 'Daylight', color: '#f4f7ff' },
  { label: 'Blue hour', color: '#9cc4ff' },
  { label: 'Magenta', color: '#ff3fb4' },
  { label: 'Cyan', color: '#29d8ff' },
]

let lightCounter = 0
export function newLightId(): string {
  return `lt_${Math.random().toString(36).slice(2, 8)}_${++lightCounter}`
}

const num = (v: unknown, lo: number, hi: number, fb: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb
const hex = (v: unknown, fb: string): string =>
  typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fb

export function sanitizeLight(raw: unknown): RelightLight {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newLightId(),
    x: num(r.x, -0.4, 1.4, 0.5),
    y: num(r.y, -0.4, 1.4, 0.3),
    height: num(r.height, -0.3, 1, 0.35),
    color: hex(r.color, '#ffffff'),
    brightness: num(r.brightness, 0, 4, 1.4),
    reach: num(r.reach, 0.1, 2, 1),
    on: r.on !== false,
  }
}

// Golden key's Original light, inlined rather than imported from presets.ts to keep the two
// modules acyclic. presets.ts owns the table; a unit test pins that this default equals it.
export function defaultRelightSettings(): Omit<RelightEffect, 'type' | 'visible'> {
  return { keep: 0.12, depth: 4, texture: 2, shine: 0, shadows: true }
}

/** The effect as it is stored today: no `lights` (an old effect's list is dropped here and read
 *  only by the conversion, through `readLegacyRelightLights`). */
export function sanitizeRelight(raw: unknown): RelightEffect {
  if (!raw || typeof raw !== 'object') return { type: 'relight', visible: true, ...defaultRelightSettings() }
  const r = raw as Record<string, unknown>
  const d = defaultRelightSettings()
  return {
    type: 'relight',
    visible: r.visible !== false,
    keep: num(r.keep, 0, 1, d.keep),
    depth: num(r.depth, 0, 20, d.depth),
    texture: num(r.texture, 0, 8, d.texture),
    shine: num(r.shine, 0, 1, d.shine),
    shadows: typeof r.shadows === 'boolean' ? r.shadows : d.shadows,
  }
}

/** The dials the facing tile is built from. With Depth blur on the same photo the tile keeps its
 *  depth normals but drops Texture relief: relief read from the crisp photo would shade the
 *  blurred colour with detail it no longer shows. */
export function relightTileDials(fx: RelightEffect, depthBlurred: boolean): RelightEffect {
  return depthBlurred && fx.texture !== 0 ? { ...fx, texture: 0 } : fx
}

/** An old saved effect's own lights (layer-box fractions), clamped, at most RELIGHT_MAX_LIGHTS.
 *  `[]` when the effect has none — a stage 2 effect never does. Read only by the conversion. */
export function readLegacyRelightLights(raw: unknown): RelightLight[] {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return Array.isArray(r.lights) ? r.lights.slice(0, RELIGHT_MAX_LIGHTS).map(sanitizeLight) : []
}
