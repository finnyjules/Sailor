// Pure mapping from the floor-style enum to viewport visibility + cinematic-floor material
// params. Kept free of three/GL so it unit-tests without a canvas; the engine reads it.

export const FLOOR_MODES = ['off', 'shadow', 'reflection', 'polished'] as const
export type FloorMode = typeof FLOOR_MODES[number]

export interface FloorVisibility {
  grid: boolean       // reference grid (GridHelper)
  shadow: boolean     // transparent shadow-catcher ground (ShadowMaterial)
  reflector: boolean  // the raster Reflector plane
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

export function floorVisibility(mode: FloorMode): FloorVisibility {
  switch (mode) {
    case 'off':        return { grid: false, shadow: false, reflector: false }
    case 'shadow':     return { grid: true,  shadow: true,  reflector: false }
    case 'reflection': return { grid: true,  shadow: true,  reflector: true  }
    case 'polished':   return { grid: false, shadow: false, reflector: true  }
  }
}

/** Cinematic owns the floor via the existing matte `cinematicFloor`; the enum only tunes it. */
export function cinematicFloorVisible(mode: FloorMode): boolean {
  return mode !== 'off'
}

/** Shadow = matte 0.5. Reflection/Polished go glossier (→ 0.05) as reflectivity rises to 1. */
export function cinematicFloorRoughness(mode: FloorMode, reflectivity: number): number {
  if (mode === 'reflection' || mode === 'polished') return 0.5 - 0.45 * clamp01(reflectivity)
  return 0.5
}

/** Read a stored doc: honour an explicit floorMode, else migrate the legacy showFloor boolean. */
export function migrateFloorMode(raw: unknown): FloorMode {
  const r = (raw ?? {}) as { floorMode?: unknown; showFloor?: unknown }
  if (typeof r.floorMode === 'string' && (FLOOR_MODES as readonly string[]).includes(r.floorMode)) {
    return r.floorMode as FloorMode
  }
  return r.showFloor === false ? 'off' : 'shadow'
}
