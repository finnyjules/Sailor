/**
 * Frame light layers, stage 1: the words and colours the panels use for lights. Pure.
 */
import type { LightLayer, LightType } from './settings'

export const LIGHT_TYPES: LightType[] = ['lamp', 'spot', 'sun']
export const LIGHT_TYPE_LABELS: Record<LightType, string> = { lamp: 'Lamp', spot: 'Spot', sun: 'Sun' }

/** The light inspector's colour swatches (from the prototype), then "any colour". */
export const LIGHT_SWATCHES = ['#ffb36b', '#fff1d6', '#ffffff', '#9fd0ff', '#ff3fa4', '#2fe0ff', '#b3ff6b'] as const

/** The row / inspector label: the user's name, else Lamp / Spot / Sun. */
export function lightLabel(l: Pick<LightLayer, 'light'> & { name?: string | null }): string {
  const own = (l.name ?? '').trim()
  return own || LIGHT_TYPE_LABELS[l.light?.type ?? 'lamp'] || 'Lamp'
}

/** A light's colour is stored as #rrggbb: a picker may hand back #rrggbbaa or upper case. */
export function lightHex(v: string): string | null {
  const m = /^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(v.trim())
  return m ? `#${m[1]!.toLowerCase()}` : null
}

/** Cone: stored as the spot's half-angle in radians (0.1..0.8), shown as the full width in degrees. */
export const CONE_DEG_MIN = 12
export const CONE_DEG_MAX = 91
export const coneToDeg = (rad: number): number => Math.round((rad * 2 * 180) / Math.PI)
export const degToCone = (deg: number): number => Math.min(0.8, Math.max(0.1, (deg / 2) * (Math.PI / 180)))
