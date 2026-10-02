/**
 * `frame-lean` build only: stands in for ~/lib/vector/morphPieces, ~/lib/vector/morph and
 * ~/lib/compositor/morphDraw (vite.embed.config.ts's frameLeanStubsPlugin) — the Frame Morph
 * engine (medial pinning, piece pairing, path blending, the morph clone's drawing) is not in the
 * lean bundle. A Frame with a `morph` motion bar is routed
 * to `frame.js` (`frameNeedsFullBundle`), and a `morph` geometry effect already is (paper.js).
 */
import type { MorphFrame, MorphStyle } from '~/lib/vector/morphPieces'
import type { LetterPose, MorphPlacement } from '~/lib/compositor/morphDraw'
import type { Paint } from '~/lib/compositor/paint'
import { leanFeatureUsed } from './leanStub.embed'

export type { MorphFrame, MorphStyle, LetterPose, MorphPlacement }

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

// ~/lib/compositor/morphDraw: `resolveMorphs` reaches these only after `prepareMorphFrames` gave
// it an outline, which the stand-in above never does — it cross-fades instead.
export function morphFillOf(layer: { kind: string; fill?: Paint; color?: Paint }): Paint | undefined {
  return layer.kind === 'text' ? layer.color : layer.fill
}

export function blendMorphPaint(a: Paint | undefined): Paint {
  leanFeatureUsed('Morph')
  return a ?? ''
}

export function ringsBBoxOfD(_d: string): { w: number; h: number } {
  return { w: 0, h: 0 }
}

export function lerpPlacement(a: MorphPlacement): Required<MorphPlacement> {
  return { x: a.x, y: a.y, rotation: 0, skewX: 0, skewY: 0 }
}

export function syntheticBoldPx(): number {
  return 0
}

export function rideLetterMotion(): { d: string; opacity: number }[] {
  return []
}
