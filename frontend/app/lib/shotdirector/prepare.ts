/**
 * The pure half of Shot Director's "Generate" and of its model picker.
 *
 * `prepareShotDispatch` turns a sheet + the cast's resolved pictures into the
 * FilmShotNode widget patch for the sheet's chosen model, or a plain-words
 * refusal (the first blocking issue). The canvas keeps only the store and node
 * calls (VueNodeCanvas.handleShotDirectorGenerate).
 *
 * `applyModelChoice` is what picking a model does to a sheet.
 */
import { materializeCast, type CastResolved } from '~/lib/shotdirector/cast'
import { compileShot, type CompileResult } from '~/lib/shotdirector/compile'
import { buildFilmShotPatch, type FilmShotWidgetPatch } from '~/lib/shotdirector/dispatch'
import { clampDuration, getProfile, type ModelProfile } from '~/lib/shotdirector/profiles'
import type { ShotSheet } from '~/lib/shotdirector/types'

/** The profile a sheet is made with (absent/unknown model → Seedance 2.0). */
export function sheetProfile(sheet: ShotSheet): ModelProfile {
  return getProfile(sheet.model ?? 'seedance-2.0')
}

export type ShotDispatch =
  | { ok: true, profile: ModelProfile, sheet: ShotSheet, result: CompileResult, patch: FilmShotWidgetPatch }
  | { ok: false, profile: ModelProfile, error: string }

export function prepareShotDispatch(
  sheet: ShotSheet,
  resolved: CastResolved,
  castDescriptors: Record<string, string>,
): ShotDispatch {
  const profile = sheetProfile(sheet)
  const { sheet: effective, issues: castIssues, bundles } = materializeCast(sheet, resolved, profile)
  const result = compileShot(effective, profile, { castDescriptors, castBundles: bundles })
  const error = [...castIssues, ...result.issues].find(i => i.level === 'error')
  if (error) return { ok: false, profile, error: error.message }
  return { ok: true, profile, sheet: effective, result, patch: buildFilmShotPatch(effective, result, profile) }
}

/**
 * Picking a model: store its id; a model that must start from a picture
 * (Kling) switches the sheet to first/last frame; a length the model can't
 * render snaps to its nearest allowed one (Veo → 8). Seedance takes any
 * length, so its sheet's duration (including Auto) is left as is.
 */
export function applyModelChoice(sheet: ShotSheet, modelId: string): ShotSheet {
  const profile = getProfile(modelId)
  const durationS = profile.durations ? clampDuration(profile, sheet.format.durationS) : sheet.format.durationS
  return {
    ...sheet,
    model: profile.id,
    mode: profile.requiresFirstFrame ? 'firstLastFrame' : sheet.mode,
    format: { ...sheet.format, durationS },
  }
}
