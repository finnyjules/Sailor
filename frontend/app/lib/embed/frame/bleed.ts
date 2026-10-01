import { ambient } from '~/lib/frame/lighting/shade'

/**
 * The black overlay alpha that darkens an unlit background exactly as the lighting pass darkens
 * it where no light reaches: the pass gives sRGB · ambient^(1/2.2) there (linear albedo × ambient,
 * then the floor at the ambient-only value), and black at alpha a over a colour c gives c·(1 − a).
 */
export function bleedAmbientAlpha(darkness: number): number {
  return 1 - Math.pow(Math.max(0, ambient(darkness)), 1 / 2.2)
}
