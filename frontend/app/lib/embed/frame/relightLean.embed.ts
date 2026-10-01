/**
 * `frame-lean` build only: stands in for BOTH ~/lib/relight/relightPass and the depth-field
 * stand-in ./depthField.embed.ts (vite.embed.config.ts's frameLeanStubsPlugin). Relight is not in
 * the lean bundle; a Frame with a `relight` effect is routed to `frame.js` (`frameNeedsFullBundle`).
 */
import type { FloatDepth } from '~/lib/relight/depthFieldCore'
import { leanFeatureUsed } from './leanStub.embed'

export { FULL_DEPTH_RECT, type DepthRect, type FloatDepth } from '~/lib/relight/depthFieldCore'

export function relightAvailable(): boolean {
  leanFeatureUsed('Relight')
  return false
}

export function applyRelight(): HTMLCanvasElement | null {
  leanFeatureUsed('Relight')
  return null
}

export function relightDepthFieldFor(): FloatDepth | null {
  leanFeatureUsed('Relight')
  return null
}

export function onRelightFieldReady(_cb: () => void): () => void {
  return () => {}
}
