/**
 * Estimated cost of one Shot Director clip, following the chosen model's
 * profile: `videoPriceUsd(modelId, …)` (shared/pricing/videoRates.ts) reads
 * the same real rate cards the rest of Sailor prices runner jobs from, with
 * `seconds` clamped exactly as dispatch.ts sends them (clampDuration) so the
 * price shown always matches what would actually be charged. An id with no
 * rate card (`videoPriceUsd` returns null — today only the test-only
 * `stub-basic`) falls back to the original flat Seedance table this file
 * shipped with (verified 2026-07-01, docs/superpowers/specs/2026-07-01-costs-
 * and-pricing-model.md), so a caller never gets `NaN` or a thrown error.
 */
import { videoPriceUsd } from '#shared/pricing/videoRates'
import type { VideoSettings } from '#shared/pricing/videoSettings'
import { SEEDANCE_MAX_INPUT_VIDEO_SECONDS } from '#shared/pricing/videoSettings'
import { clampDuration, getProfile } from '~/lib/shotdirector/profiles'
import type { ShotSheet } from '~/lib/shotdirector/types'

const LEGACY_SEEDANCE_PER_SECOND_USD: Record<string, [plain: number, videoRef: number]> = {
  '480p': [0.08, 0.10],
  '720p': [0.18, 0.22],
  '1080p': [0.45, 0.55],
  '4k': [1.00, 1.25],
}

function hasVideoRef(sheet: ShotSheet): boolean {
  return sheet.mode === 'reference' && sheet.references.some(r => r.kind === 'video')
}

/** The original flat-rate estimate — used only when the model has no shared rate card. */
function legacySeedanceUSD(sheet: ShotSheet): number {
  const tier = LEGACY_SEEDANCE_PER_SECOND_USD[sheet.format.resolution.toLowerCase()] ?? LEGACY_SEEDANCE_PER_SECOND_USD['1080p']!
  const dur = sheet.format.durationS <= 0 ? 5 : sheet.format.durationS
  return (hasVideoRef(sheet) ? tier[1] : tier[0]) * dur
}

export function estimateShotUSD(sheet: ShotSheet, modelId = 'seedance-2.0'): number {
  const profile = getProfile(modelId)
  const settings: VideoSettings = {
    // Same effective-duration rule as buildFilmShotPatch in dispatch.ts:
    // both must clamp the sheet's raw durationS the same way, or the price
    // shown and the clip actually dispatched would disagree.
    seconds: clampDuration(profile, sheet.format.durationS),
    resolution: sheet.format.resolution ? sheet.format.resolution.toLowerCase() : null,
    audio: sheet.audio.generate,
    // Only Seedance's rate card bills reference-video seconds at all
    // (inputVideoFactor); passing this for every model is harmless elsewhere.
    inputVideoSeconds: hasVideoRef(sheet) ? SEEDANCE_MAX_INPUT_VIDEO_SECONDS : 0,
  }
  return videoPriceUsd(modelId, settings) ?? legacySeedanceUSD(sheet)
}

export function formatShotUSD(sheet: ShotSheet, modelId = 'seedance-2.0'): string {
  return `~$${estimateShotUSD(sheet, modelId).toFixed(2)}`
}
