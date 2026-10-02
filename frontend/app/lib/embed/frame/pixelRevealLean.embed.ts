/**
 * `frame-lean` build only: stands in for BOTH ~/lib/motionx/reveal/paintPixelReveal and
 * ~/lib/motionx/reveal/pixelReveal (vite.embed.config.ts's frameLeanStubsPlugin). Pixel reveal's
 * WebGL2 painter and its maths are not in the lean bundle; a Frame with a `pixelreveal` bar is
 * routed to `frame.js` (`frameNeedsFullBundle`).
 */
import type { PixelRevealPiece } from '~/lib/motionx/reveal/paintPixelReveal'
import type { PixelRevealResolvedParams } from '~/lib/motionx/reveal/pixelReveal'
import { leanFeatureUsed } from './leanStub.embed'

export type { PixelRevealPiece }

export function pixelRevealAvailable(): boolean {
  leanFeatureUsed('Pixel reveal')
  return false
}

export function drawRevealPixelReveal(): boolean {
  leanFeatureUsed('Pixel reveal')
  return false
}

export function pixelRevealTextPieces(): PixelRevealPiece[] {
  leanFeatureUsed('Pixel reveal')
  return []
}

/** Only a `pixelreveal` bar is read here (never in lean): a placeholder the stubbed painter ignores. */
export function pixelRevealParams(params: Record<string, unknown> | undefined): PixelRevealResolvedParams {
  leanFeatureUsed('Pixel reveal')
  return { look: { id: 'pixelreveal', label: 'Pixel reveal' }, out: params?.dir === 'out' } as unknown as PixelRevealResolvedParams
}
