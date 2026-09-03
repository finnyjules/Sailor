import type { SpaceTypeEffect } from '../effect'
import { ribbonEffect } from './ribbon'
import { stripesEffect } from './stripes'
import { tickerEffect } from './ticker'
import { cylinderEffect } from './cylinder'
import { fieldEffect } from './field'
import { coilEffect } from './coil'
import { cascadeEffect } from './cascade'
import { boostEffect } from './boost'
import { meltEffect } from './melt'
import { onionburstEffect } from './onionburst'
import { elasticEffect } from './elastic'
import { stringEffect } from './string'
import { blendEffect } from './blend'
import { echoEffect } from './echo'
import { sliceGlitchEffect } from './sliceGlitch'
import { streamerEffect } from './streamer'
import { spiralEffect } from './spiral'
import { tunnelEffect } from './tunnel'
import { contourEffect } from './contour'
import { ballEffect } from './ball'
import { turntableEffect } from './turntable'
import { tearEffect } from './tear'
import { slitScanEffect } from './slitScan'
import { cornerPinEffect } from './cornerPin'
import { shutterEffect } from './shutter'
import { ringEffect } from './ring'
import { loftEffect } from './loft'
import { slotEffect } from './slot'
import { withSeparatorControls } from '../separator'

/** All registered Space Type effects, in picker order. Add new effect modules here.
 *  Every entry passes through withSeparatorControls, which appends the shared
 *  separator controls to tile-based effects — declare the controls ONCE there,
 *  not per effect. */
export const SPACE_TYPE_EFFECTS: SpaceTypeEffect[] = [
  ribbonEffect,
  stripesEffect,
  tickerEffect,
  cylinderEffect,
  fieldEffect,
  coilEffect,
  cascadeEffect,
  boostEffect,
  meltEffect,
  onionburstEffect,
  elasticEffect,
  stringEffect,
  blendEffect,
  echoEffect,
  sliceGlitchEffect,
  streamerEffect,
  spiralEffect,
  tunnelEffect,
  contourEffect,
  ballEffect,
  turntableEffect,
  tearEffect,
  slitScanEffect,
  cornerPinEffect,
  shutterEffect,
  ringEffect,
  loftEffect,
  slotEffect,
].map(withSeparatorControls)

export function getEffect(id: string): SpaceTypeEffect {
  // Case-insensitive so configs saved under an old mixed-case id (e.g. 'cornerPin' → 'cornerpin')
  // still resolve. Callers should normalize to the resolved effect's canonical `.id`.
  const lower = String(id).toLowerCase()
  return SPACE_TYPE_EFFECTS.find(e => e.id.toLowerCase() === lower) ?? SPACE_TYPE_EFFECTS[0]!
}
