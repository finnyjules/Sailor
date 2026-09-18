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
import { pileEffect } from './pile'
import { withSeparatorControls } from '../separator'

/** All registered Space Type effects, in picker order. Add new effect modules here.
 *  Every entry passes through withSeparatorControls, which appends the shared
 *  separator controls to tile-based effects — declare the controls ONCE there,
 *  not per effect. */
// The /* @__PURE__ */ annotation is load-bearing, not cosmetic: without it
// Rollup treats this top-level .map() as a retained side effect, so importing
// ANY symbol from this module drags all 28 effect modules into the bundle.
// That silently defeated the per-effect embed split (every
// public/embed/spacetype-<id>.js grew from ~813KB to ~1.21MB) — see
// tests/unit/embed-build-output.unit.spec.ts's marker-content test.
// scripts/spacetype-effect-list.mjs parses this array textually; its regex
// tolerates the annotation between `=` and `[`.
export const SPACE_TYPE_EFFECTS: SpaceTypeEffect[] = /* @__PURE__ */ [
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
  pileEffect,
].map(withSeparatorControls)

export function getEffect(id: string): SpaceTypeEffect {
  // Case-insensitive so configs saved under an old mixed-case id (e.g. 'cornerPin' → 'cornerpin')
  // still resolve. Callers should normalize to the resolved effect's canonical `.id`.
  const lower = String(id).toLowerCase()
  return SPACE_TYPE_EFFECTS.find(e => e.id.toLowerCase() === lower) ?? SPACE_TYPE_EFFECTS[0]!
}
