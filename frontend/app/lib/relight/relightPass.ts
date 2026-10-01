/**
 * Relight's per-photo GPU work, as the painter sees it. Since Frame light layers stage 2 Relight
 * no longer lights the photo itself: the Frame's light layers do, in the one Frame lighting pass
 * (lib/frame/lighting/lightingPass.ts). Relight supplies two things from the photo, both made by
 * the pass in lib/frame/lighting/facingPass.ts (its normal, relief and contact maths are the old
 * Relight shader's, ported verbatim):
 * - Original light — the photo's own paint, flattened toward its albedo by 1 − keep;
 * - the facing tile — which way each pixel faces, for the Frame's facing map.
 * The painter imports them from HERE so the lean web-export bundle's stand-in
 * (lib/embed/frame/relightLean.embed.ts) replaces all of it at once.
 * Specs: docs/superpowers/specs/2026-09-30-relight-layer-effect-design.md,
 * docs/superpowers/specs/2026-10-01-frame-light-layers-design.md
 */
import {
  FACING_FRAG, facingAvailable, facingUnavailableReason, __facingPassRuns, renderFacingTile, renderOriginalLight, releaseFacing,
} from '~/lib/frame/lighting/facingPass'
import type { RelightEffect } from './settings'

export { depthRectUniforms, originalLightActive } from '~/lib/frame/lighting/facingPass'

/** The per-photo Relight shader (facing tile + Original light). Its `normalAt` / `shadowTo` are
 *  the pre-stage-2 Relight shader's, verbatim. */
export const RELIGHT_FRAG = FACING_FRAG

export function relightShouldRun(fx: RelightEffect): boolean {
  return fx.visible !== false
}

export function relightAvailable(): boolean {
  return facingAvailable()
}

export function relightUnavailableReason(): string {
  return facingUnavailableReason()
}

/** Assertion marker: "Relight applied" vs "silently drawn plain" — every real draw of the
 *  per-photo pass (a facing tile, or Original light). */
export function __relightRuns(): number {
  return __facingPassRuns()
}

/** The photo's facing tile (see facingPass.ts `renderFacingTile`). The pass's own canvas. */
export const relightFacingTile = renderFacingTile

/** The photo's paint with Original light applied (see facingPass.ts `renderOriginalLight`); null
 *  when keep is 1 (nothing to do). The pass's own canvas. */
export const relightOriginalLight = renderOriginalLight

/** Free the per-photo pass's GL context (the next use rebuilds it). */
export const releaseRelight = releaseFacing
