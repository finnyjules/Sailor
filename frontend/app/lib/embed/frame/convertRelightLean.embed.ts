/**
 * `frame-lean` build only: stands in for ~/lib/frame/lighting/convertRelight
 * (vite.embed.config.ts's frameLeanStubsPlugin). Relight is not in the lean bundle — a Frame with
 * any `relight` effect is routed to `frame.js` (`frameNeedsFullBundle`) — so there is never an
 * old Relight light to convert here, and the conversion's effect-stack / Setups imports stay out.
 * `relightPhotoBox` / `frameToRelightBox` serve only `lightsInBox` (Relight's Finish guide), which
 * no export calls.
 */
import type { LocalLayer, LightLayer } from '~/composables/useCompositorLayers'
import type { FrameLighting } from '~/lib/frame/lighting/settings'
import { DEFAULT_LIGHTING } from '~/lib/frame/lighting/settings'
import { leanFeatureUsed } from './leanStub.embed'

export function isRelightPhoto(_layer: LocalLayer): boolean { return false }
export function hasLegacyRelightLights(_layers: readonly LocalLayer[]): boolean { return false }
export function relightLightsToLayers(layers: readonly LocalLayer[], lighting: FrameLighting | null | undefined) {
  return { layers: layers as LocalLayer[], lighting: lighting ?? { ...DEFAULT_LIGHTING }, dropped: 0, changed: false }
}
export function relightPhotoBox(_layer: LocalLayer): { w: number; h: number } {
  leanFeatureUsed('Relight')
  return { w: 0, h: 0 }
}
export function relightBoxToFrame(_l: LocalLayer, fx: number, fy: number): { x: number; y: number } {
  leanFeatureUsed('Relight')
  return { x: fx, y: fy }
}
export function frameToRelightBox(_l: LocalLayer, x: number, y: number): { x: number; y: number } {
  leanFeatureUsed('Relight')
  return { x, y }
}
export function setupToLightLayers(): LightLayer[] {
  leanFeatureUsed('Relight')
  return []
}
