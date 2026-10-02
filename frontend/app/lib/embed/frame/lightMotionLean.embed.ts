/**
 * `frame-lean` build only: stands in for ~/lib/frame/lighting/motion (vite.embed.config.ts's
 * frameLeanStubsPlugin). Animated lights (a light dial, a Lift or a Darkness band) are not in the
 * lean bundle; such a Frame is routed to `frame.js` (`frameNeedsFullBundle`, 'Animated lights').
 * Both appliers return their input unchanged, and report a routing miss when they would have
 * applied something.
 */
import { leanFeatureUsed } from './leanStub.embed'

export const LIGHT_MOTION_KEYS = ['height', 'color', 'brightness', 'reach', 'aimX', 'aimY', 'cone'] as const
export type LightMotionKey = typeof LIGHT_MOTION_KEYS[number]
export const DARKNESS_PATH = 'frame.darkness'

export const isLightBandPath = (path: string): boolean =>
  /^layers\.[^.]+\.(light\.[a-zA-Z]+|lift)$|^frame\.darkness$/.test(path)

export function applyLightValue<L>(layer: L, prop: string, _value: unknown): L {
  if (prop === 'lift' || prop.startsWith('light.')) leanFeatureUsed('Animated lights')
  return layer
}

export function applyLightingTracks<L>(lighting: L, tracks: ReadonlyArray<{ path?: string; muted?: boolean }> | undefined, _t: number | undefined): L {
  if (tracks?.some(tr => tr.path === DARKNESS_PATH && !tr.muted)) leanFeatureUsed('Animated lights')
  return lighting
}
