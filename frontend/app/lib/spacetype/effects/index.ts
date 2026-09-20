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
import { showCoverringEffect } from './showCoverring'
import { showSphereEffect } from './showSphere'
import { showGlobeEffect } from './showGlobe'
import { showCloudEffect } from './showCloud'
import { showDomeEffect } from './showDome'
import { showSpiralEffect } from './showSpiral'
import { showBloomEffect } from './showBloom'
import { showCoverflowEffect } from './showCoverflow'
import { showFocusEffect } from './showFocus'
import { showFilmstripEffect } from './showFilmstrip'
import { showTotemEffect } from './showTotem'
import { showFeedEffect } from './showFeed'
import { showCascadeEffect } from './showCascade'
import { showGridEffect } from './showGrid'
import { showMarqueeEffect } from './showMarquee'
import { showIsoEffect } from './showIso'
import { showTurntableEffect } from './showTurntable'
import { showParallaxEffect } from './showParallax'
import { showOrbitEffect } from './showOrbit'
import { showHaloEffect } from './showHalo'
import { showWheelEffect } from './showWheel'
import { showVortexEffect } from './showVortex'
import { showStackEffect } from './showStack'
import { showTunnelEffect } from './showTunnel'
import { showDeckEffect } from './showDeck'
import { showSlideEffect } from './showSlide'
import { showFanEffect } from './showFan'
import { showStageEffect } from './showStage'
import { showFocusshiftEffect } from './showFocusshift'
import { showTrailEffect } from './showTrail'
import { showBurstEffect } from './showBurst'
import { showTossEffect } from './showToss'
import { showDanceEffect } from './showDance'
import { showMedleyEffect } from './showMedley'
import { withSeparatorControls } from '../separator'
import { showcaseEffectId } from '../layouts/index'

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
// tolerates the annotation between `=` and `[` — but NOT comments inside the array (it
// splits on commas), so notes about entries live up here:
//   · everything from showCoverringEffect on is a Showcase card layout, one effect each
//     (./showcase.ts), in gallery order. `ringEffect` is the first of them; it keeps its old
//     place so nothing that indexes this list moves.
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
  showCoverringEffect,
  showSphereEffect,
  showGlobeEffect,
  showCloudEffect,
  showDomeEffect,
  showSpiralEffect,
  showBloomEffect,
  showCoverflowEffect,
  showFocusEffect,
  showFilmstripEffect,
  showTotemEffect,
  showFeedEffect,
  showCascadeEffect,
  showGridEffect,
  showMarqueeEffect,
  showIsoEffect,
  showTurntableEffect,
  showParallaxEffect,
  showOrbitEffect,
  showHaloEffect,
  showWheelEffect,
  showVortexEffect,
  showStackEffect,
  showTunnelEffect,
  showDeckEffect,
  showSlideEffect,
  showFanEffect,
  showStageEffect,
  showFocusshiftEffect,
  showTrailEffect,
  showBurstEffect,
  showTossEffect,
  showDanceEffect,
  showMedleyEffect,
].map(withSeparatorControls)

export function getEffect(id: string): SpaceTypeEffect {
  // Case-insensitive so configs saved under an old mixed-case id (e.g. 'cornerPin' → 'cornerpin')
  // still resolve. Callers should normalize to the resolved effect's canonical `.id`.
  const lower = String(id).toLowerCase()
  return SPACE_TYPE_EFFECTS.find(e => e.id.toLowerCase() === lower) ?? SPACE_TYPE_EFFECTS[0]!
}

/** The entry a legacy Showcase scene belongs to now, or null when it is already home.
 *  For a while every card layout lived under the one `ring` id, chosen by a `layout` param;
 *  each is now its own effect. `ring` still DRAWS such a scene correctly (see ./ring.ts), so
 *  only the editor needs this — to show the right layout's dials. */
export function rehomeLegacyShowcase(effectId: string, params: unknown): string | null {
  const saved = (params as { layout?: unknown } | null | undefined)?.layout
  if (effectId !== 'ring' || saved == null) return null
  const target = showcaseEffectId(String(saved).toLowerCase())
  return target !== 'ring' && SPACE_TYPE_EFFECTS.some(e => e.id === target) ? target : null
}
