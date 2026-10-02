import { ambient } from '~/lib/frame/lighting/shade'
import { readFrameLighting, type FrameLighting } from '~/lib/frame/lighting/settings'
import { applyLightingTracks } from '~/lib/frame/lighting/motion'
import type { Track } from '~/lib/motionx'

/**
 * The black overlay alpha that darkens an unlit background exactly as the lighting pass darkens
 * it where no light reaches: the pass gives sRGB · ambient^(1/2.2) there (linear albedo × ambient,
 * then the floor at the ambient-only value), and black at alpha a over a colour c gives c·(1 − a).
 */
export function bleedAmbientAlpha(darkness: number): number {
  return 1 - Math.pow(Math.max(0, ambient(darkness)), 1 / 2.2)
}

/**
 * The bleed's darkening for one paint at Frame time `tSec`: the art is lit (ambient darkened by
 * Darkness), and the bleed outside it is the background alone, so it gets the same ambient
 * darkening or the artboard edge shows. An animated Darkness band moves it with the art. 0 when
 * the Frame has no visible light, the background is not lit, or the lighting pass is unavailable.
 */
export function bleedDarknessAt(o: {
  hasVisibleLight: boolean
  lighting: FrameLighting | undefined
  motionx: readonly Track[] | undefined
  tSec: number
  available: () => boolean
}): number {
  if (!o.hasVisibleLight) return 0
  const lighting = readFrameLighting({ sailor_localLighting: applyLightingTracks(o.lighting, o.motionx as Track[] | undefined, o.tSec) })
  return lighting.backgroundLit && o.available() ? bleedAmbientAlpha(lighting.darkness) : 0
}
