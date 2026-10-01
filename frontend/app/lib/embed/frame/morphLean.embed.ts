/**
 * `frame-lean` build only: stands in for BOTH ~/lib/vector/morphPieces and ~/lib/vector/morph
 * (vite.embed.config.ts's frameLeanStubsPlugin) — the Frame Morph engine (medial pinning, piece
 * pairing, path blending) is not in the lean bundle. A Frame with a `morph` motion bar is routed
 * to `frame.js` (`frameNeedsFullBundle`), and a `morph` geometry effect already is (paper.js).
 */
import type { MorphFrame, MorphStyle } from '~/lib/vector/morphPieces'
import { leanFeatureUsed } from './leanStub.embed'

export type { MorphFrame, MorphStyle }

/** The painter catches this and cross-fades — but a use here is a routing bug, so say so. */
export function prepareMorphFrames(_dA: string, _dB: string, _style: MorphStyle): (t: number) => MorphFrame {
  leanFeatureUsed('Morph')
  throw new Error('Morph is not in the lean Frame bundle')
}

export function prepareMorph(_dA: string, _dB: string, _style: MorphStyle): (t: number) => string {
  leanFeatureUsed('Morph')
  throw new Error('Morph is not in the lean Frame bundle')
}

export function ringsFromD(_d: string): MorphFrame['rings'] {
  return []
}

export function ringsToD(_rings: MorphFrame['rings']): string {
  return ''
}

/** The `morph` geometry effect: pass the shape through unchanged (never reached — see above). */
export function blendPath(dA: string): string {
  leanFeatureUsed('Morph')
  return dA
}
