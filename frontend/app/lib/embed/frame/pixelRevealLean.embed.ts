/**
 * `frame-lean` build only: stands in for ~/lib/motionx/reveal/paintPixelReveal
 * (vite.embed.config.ts's frameLeanStubsPlugin). Pixel reveal's WebGL2 painter is not in the
 * lean bundle; a Frame with a `pixelreveal` bar is routed to `frame.js` (`frameNeedsFullBundle`).
 */
import type { PixelRevealPiece } from '~/lib/motionx/reveal/paintPixelReveal'
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
