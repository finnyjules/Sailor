/**
 * `frame-lean` build only: stands in for ~/lib/compositor/finishLights (vite.embed.config.ts's
 * frameLeanStubsPlugin). Foil and Spot UV lit by the Frame's light layers are not in the lean
 * bundle; a Frame with a visible light and a foil / `spot_uv` is routed to `frame.js`
 * (`frameNeedsFullBundle`). The painter falls back to the hidden light when this returns false.
 */
import { leanFeatureUsed } from './leanStub.embed'

export function applyFinishLit(..._args: unknown[]): boolean {
  leanFeatureUsed('Print finishes under lights')
  return false
}
