/**
 * `frame-lean` build only: stands in for ~/lib/compositor/surfacesRegistry
 * (vite.embed.config.ts's frameLeanStubsPlugin). Surfaces belong to Relight, which is not in the
 * lean bundle — a Frame with a `relight` effect is routed to `frame.js` (`frameNeedsFullBundle`)
 * — so a lean file never carries a surfaces asset and the painter never has one to read.
 */
import type { DepthRef } from '~/lib/compositor/depthRegistry'
import { leanFeatureUsed } from './leanStub.embed'

export function surfacesImageFor(_ref: DepthRef): HTMLImageElement | null { return null }

export function seedSurfacesImage(_ref: DepthRef, _img: HTMLImageElement): void {
  leanFeatureUsed('Relight')
}
